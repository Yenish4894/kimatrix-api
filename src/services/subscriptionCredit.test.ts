import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EntityManager } from "typeorm";
import type { AuditLogRepository } from "@/repositories/AuditLogRepository";
import type { CompanyRepository } from "@/repositories/CompanyRepository";
import type { PaymentRepository } from "@/repositories/PaymentRepository";
import type { PlanRepository } from "@/repositories/PlanRepository";
import type { SubscriptionRepository } from "@/repositories/SubscriptionRepository";
import type { NotificationService } from "@/services/NotificationService";
import type { PaypalService } from "@/services/PaypalService";
import type { TransactionRunner } from "@/utils/db";
import { SubscriptionService } from "@/services/SubscriptionService";
import { closeEmailQueue } from "@/queues/email.queue";

/**
 * SubscriptionService.creditCycle — the recurring-sale credit path.
 *
 * The amount-mismatch branch is the one that matters for money: a sale whose amount or
 * currency matches no candidate plan must NOT buy a period, must NOT throw (PayPal would
 * retry forever), and must leave an audit row for a human to credit or refund.
 */

after(async () => {
  await closeEmailQueue();
});

const tx = { tx: true } as unknown as EntityManager;
const db: TransactionRunner = {
  transaction: <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> => fn(tx),
};

const PLAN = { id: "plan-30", duration_days: 30, price: "29.00", currency: "USD" };

function harness() {
  const calls: [string, ...unknown[]][] = [];
  const starts = new Date("2026-09-13T00:00:00Z");
  const ends = new Date("2026-10-13T00:00:00Z");

  const paypalService = {
    getSubscription: async (id: string) => {
      calls.push(["getSubscription", id]);
      return { plan_id: "P-REMOTE" };
    },
  } as unknown as PaypalService;

  const subscriptionRepository = {
    lockForCycleCredit: async (paypalId: string, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["lockForCycleCredit", paypalId]);
      return { id: "sub-1", company_id: "co-1", plan_id: "plan-30", trial_ends_at: null };
    },
    findCyclePlan: async (params: Record<string, unknown>, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["findCyclePlan", params]);
      return PLAN;
    },
    update: async (id: string, data: Record<string, unknown>, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["subscriptionUpdate", id, data]);
    },
  } as unknown as SubscriptionRepository;

  const auditLogRepository = {
    insertAmountMismatchOnce: async (m: EntityManager, entry: Record<string, unknown>) => {
      assert.equal(m, tx, "the mismatch row is written in the credit transaction");
      calls.push(["auditMismatch", entry]);
    },
  } as unknown as AuditLogRepository;

  const paymentRepository = {
    insertSubscriptionCycle: async (data: Record<string, unknown>, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["insertCycle", data]);
      return [{ id: "pay-1" }];
    },
    setSubscriptionWindow: async (id: string, s: Date, e: Date, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["setWindow", id, s, e]);
    },
  } as unknown as PaymentRepository;

  const companyRepository = {
    extendSubscription: async (params: Record<string, unknown>, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["extendSubscription", params["companyId"], params["durationDays"]]);
      return { subscriptionStartsAt: starts, subscriptionEndsAt: ends };
    },
    clearSubscriptionEndedNotice: async (id: string, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["clearNotice", id]);
    },
  } as unknown as CompanyRepository;

  const notificationService = {
    sendPaymentReceipt: (p: { paymentId: string; companyId: string }) => {
      calls.push(["receipt", p.paymentId, p.companyId]);
      return Promise.resolve();
    },
  } as unknown as NotificationService;

  const service = new SubscriptionService(
    paypalService,
    companyRepository,
    notificationService,
    subscriptionRepository,
    {} as PlanRepository,
    paymentRepository,
    auditLogRepository,
    db,
  );
  return { service, calls, starts, ends };
}

const named = (calls: [string, ...unknown[]][], name: string) => calls.filter(([n]) => n === name);

describe("SubscriptionService.creditCycle — amount mismatch", () => {
  it("does not credit a sale whose amount matches no plan, and records it for review", async () => {
    const { service, calls } = harness();

    const credited = await service.creditCycle({
      paypalSubscriptionId: "I-SUB",
      saleId: "SALE-1",
      amount: "19.00",
      currency: "USD",
    });

    assert.equal(credited, false);
    // Candidate plans are looked up with PayPal's plan and the stored plan.
    const [[, planParams]] = named(calls, "findCyclePlan") as [[string, Record<string, unknown>]];
    assert.deepEqual(planParams, {
      remotePlanId: "P-REMOTE",
      storedPlanId: "plan-30",
      subscriptionId: "sub-1",
      amount: "19.00",
      currency: "USD",
    });

    const mismatches = named(calls, "auditMismatch") as [string, Record<string, unknown>][];
    assert.equal(mismatches.length, 1);
    assert.deepEqual(mismatches[0]?.[1], {
      actorEmail: "system:paypal-webhook",
      saleId: "SALE-1",
      before: { planId: "plan-30", price: "29.00", currency: "USD" },
      after: {
        amount: "19.00",
        currency: "USD",
        subscriptionId: "sub-1",
        paypalSubscriptionId: "I-SUB",
        companyId: "co-1",
      },
      note: "Recurring sale NOT credited: amount/currency differs from the plan. Check PayPal, then credit or refund.",
    });

    // Nothing that grants access or records money happened.
    for (const name of [
      "insertCycle",
      "extendSubscription",
      "setWindow",
      "subscriptionUpdate",
      "clearNotice",
      "receipt",
    ]) {
      assert.equal(named(calls, name).length, 0, `${name} must not run on a mismatch`);
    }
  });

  it("treats the right amount in the wrong currency as a mismatch too", async () => {
    const { service, calls } = harness();
    const credited = await service.creditCycle({
      paypalSubscriptionId: "I-SUB",
      saleId: "SALE-2",
      amount: "29.00",
      currency: "ZAR",
    });
    assert.equal(credited, false);
    assert.equal(named(calls, "auditMismatch").length, 1);
    assert.equal(named(calls, "insertCycle").length, 0);
  });

  it("keys the audit row on the sale id truncated to the 64-char column", async () => {
    const { service, calls } = harness();
    const longSale = "S".repeat(80);
    await service.creditCycle({
      paypalSubscriptionId: "I-SUB",
      saleId: longSale,
      amount: "1.00",
      currency: "USD",
    });
    const [[, entry]] = named(calls, "auditMismatch") as [[string, Record<string, unknown>]];
    assert.equal(entry["saleId"], "S".repeat(64));
  });

  it("control: a matching sale IS credited — ledger row, extension, window, receipt", async () => {
    const { service, calls, starts, ends } = harness();

    const credited = await service.creditCycle({
      paypalSubscriptionId: "I-SUB",
      saleId: "SALE-OK",
      amount: "29.00",
      currency: "USD",
    });

    assert.equal(credited, true);
    assert.equal(named(calls, "auditMismatch").length, 0);
    assert.deepEqual(named(calls, "insertCycle"), [
      [
        "insertCycle",
        {
          companyId: "co-1",
          planId: "plan-30",
          subscriptionId: "sub-1",
          saleId: "SALE-OK",
          amount: "29.00",
          currency: "USD",
        },
      ],
    ]);
    assert.deepEqual(named(calls, "extendSubscription"), [["extendSubscription", "co-1", 30]]);
    assert.deepEqual(named(calls, "setWindow"), [["setWindow", "pay-1", starts, ends]]);
    assert.deepEqual(named(calls, "clearNotice"), [["clearNotice", "co-1"]]);
    assert.deepEqual(named(calls, "receipt"), [["receipt", "pay-1", "co-1"]]);
  });
});
