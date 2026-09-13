import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EntityManager } from "typeorm";
import type { CompanyRepository } from "@/repositories/CompanyRepository";
import type { PaymentRepository } from "@/repositories/PaymentRepository";
import type { NotificationService } from "@/services/NotificationService";
import type { PaypalService } from "@/services/PaypalService";
import type { TransactionRunner } from "@/utils/db";
import { RECONCILE_AFTER_MINUTES, RECONCILE_BATCH_SIZE } from "@/utils/paymentReconcile";
import { PaymentService } from "@/services/PaymentService";
import { closeEmailQueue } from "@/queues/email.queue";

/**
 * PaymentService.reconcileStuckCaptures, end to end with fakes.
 *
 * The decision table itself is covered in utils/paymentReconcile.test.ts. This pins what
 * the service DOES with each decision: complete goes through the same locked
 * finalizeCapture as capture and webhook (and so is exactly-once), fail is conditional
 * on the row still being `capturing`, wait touches nothing, and one row's error never
 * stops the rest.
 */

after(async () => {
  await closeEmailQueue();
});

const tx = { tx: true } as unknown as EntityManager;
const db: TransactionRunner = {
  transaction: <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> => fn(tx),
};

const captured = (status: string) => ({
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: [{ id: "CAP", status }] } }],
});

interface Harness {
  service: PaymentService;
  calls: [string, ...unknown[]][];
}

function harness(opts: {
  rows: { id: string; paypal_order_id: string; company_id: string }[];
  orders: Record<string, unknown>;
  /** Status the row has when finalizeCapture re-reads it under lock. */
  lockedStatus?: string;
}): Harness {
  const calls: [string, ...unknown[]][] = [];
  const starts = new Date("2026-09-13T00:00:00Z");
  const ends = new Date("2026-10-13T00:00:00Z");

  const paymentRepository = {
    findStuckCapturing: async (claimedBefore: Date, limit: number) => {
      calls.push(["findStuckCapturing", claimedBefore, limit]);
      return opts.rows;
    },
    findByIdForUpdate: async (id: string, m: EntityManager) => {
      assert.equal(m, tx, "finalize must lock inside its own transaction");
      calls.push(["findByIdForUpdate", id]);
      return {
        id,
        status: opts.lockedStatus ?? "capturing",
        kind: "order",
        company: { id: "co-1" },
        plan: { id: "plan-30", durationDays: 30 },
        subscriptionStartsAt: opts.lockedStatus === "captured" ? starts : null,
        subscriptionEndsAt: opts.lockedStatus === "captured" ? ends : null,
      };
    },
    updateCaptured: async (id: string, data: Record<string, unknown>, m: EntityManager) => {
      assert.equal(m, tx);
      calls.push(["updateCaptured", id, data]);
    },
    failIfCapturing: async (id: string, response: Record<string, unknown>) => {
      calls.push(["failIfCapturing", id, response]);
      return true;
    },
  } as unknown as PaymentRepository;

  const companyRepository = {
    extendSubscription: async (
      params: { companyId: string; planId: string; durationDays: number },
      m: EntityManager,
    ) => {
      assert.equal(m, tx);
      calls.push(["extendSubscription", params.companyId, params.planId, params.durationDays]);
      return { subscriptionStartsAt: starts, subscriptionEndsAt: ends };
    },
  } as unknown as CompanyRepository;

  const paypalService = {
    getOrder: async (orderId: string) => {
      calls.push(["getOrder", orderId]);
      const order = opts.orders[orderId];
      if (order instanceof Error) throw order;
      return order ?? null;
    },
  } as unknown as PaypalService;

  const notificationService = {
    sendPaymentReceipt: (p: { paymentId: string; companyId: string }) => {
      calls.push(["receipt", p.paymentId, p.companyId]);
      return Promise.resolve();
    },
  } as unknown as NotificationService;

  const unused = {} as never;
  const service = new PaymentService(
    unused,
    paymentRepository,
    companyRepository,
    paypalService,
    unused,
    unused,
    notificationService,
    db,
  );
  return { service, calls };
}

const named = (calls: [string, ...unknown[]][], name: string) => calls.filter(([n]) => n === name);

describe("PaymentService.reconcileStuckCaptures", () => {
  it("completes, fails, waits and survives an error — one row each", async () => {
    const { service, calls } = harness({
      rows: [
        { id: "pay-done", paypal_order_id: "O-DONE", company_id: "co-1" },
        { id: "pay-gone", paypal_order_id: "O-GONE", company_id: "co-1" },
        { id: "pay-pending", paypal_order_id: "O-PENDING", company_id: "co-1" },
        { id: "pay-boom", paypal_order_id: "O-BOOM", company_id: "co-1" },
      ],
      orders: {
        "O-DONE": captured("COMPLETED"),
        // O-GONE absent: PayPal answers 404 → null.
        "O-PENDING": captured("PENDING"),
        "O-BOOM": new Error("PayPal 503"),
      },
    });

    const before = Date.now();
    const counts = await service.reconcileStuckCaptures();

    assert.deepEqual(counts, { completed: 1, failed: 1, waiting: 1, errors: 1 });

    // Defaults: the batch size and the 15-minute cutoff.
    const [[, claimedBefore, limit]] = named(calls, "findStuckCapturing") as [
      [string, Date, number],
    ];
    assert.equal(limit, RECONCILE_BATCH_SIZE);
    const expectedCutoff = before - RECONCILE_AFTER_MINUTES * 60_000;
    assert.ok(Math.abs(claimedBefore.getTime() - expectedCutoff) < 5_000);

    // Every row was asked about, in order, despite the error on the last.
    assert.deepEqual(
      named(calls, "getOrder").map(([, id]) => id),
      ["O-DONE", "O-GONE", "O-PENDING", "O-BOOM"],
    );

    // complete → the locked finalize: extend by the plan, mark captured, one receipt.
    assert.deepEqual(named(calls, "findByIdForUpdate"), [["findByIdForUpdate", "pay-done"]]);
    assert.deepEqual(named(calls, "extendSubscription"), [
      ["extendSubscription", "co-1", "plan-30", 30],
    ]);
    const [[, updatedId, data]] = named(calls, "updateCaptured") as [
      [string, string, Record<string, unknown>],
    ];
    assert.equal(updatedId, "pay-done");
    assert.equal(data["status"], "captured");
    assert.deepEqual(data["paypalResponse"], captured("COMPLETED"));
    assert.deepEqual(named(calls, "receipt"), [["receipt", "pay-done", "co-1"]]);

    // fail → conditional failIfCapturing with the reason and the (null) order.
    const [[, failedId, response]] = named(calls, "failIfCapturing") as [
      [string, string, Record<string, unknown>],
    ];
    assert.equal(failedId, "pay-gone");
    assert.equal(response["reason"], "order_unknown_to_paypal");
    assert.equal(response["order"], null);
    assert.equal(typeof response["reconciledAt"], "string");

    // wait and error → nothing written for those rows.
    assert.equal(named(calls, "updateCaptured").length, 1);
    assert.equal(named(calls, "failIfCapturing").length, 1);
  });

  it("is exactly-once: a row finalized meanwhile is counted but not extended or re-receipted", async () => {
    const { service, calls } = harness({
      rows: [{ id: "pay-raced", paypal_order_id: "O-RACED", company_id: "co-1" }],
      orders: { "O-RACED": captured("COMPLETED") },
      lockedStatus: "captured",
    });

    const counts = await service.reconcileStuckCaptures();

    assert.deepEqual(counts, { completed: 1, failed: 0, waiting: 0, errors: 0 });
    assert.equal(named(calls, "extendSubscription").length, 0);
    assert.equal(named(calls, "updateCaptured").length, 0);
    assert.equal(named(calls, "receipt").length, 0);
  });

  it("marks an approved-but-never-captured order failed rather than capturing it late", async () => {
    const { service, calls } = harness({
      rows: [{ id: "pay-approved", paypal_order_id: "O-APPROVED", company_id: "co-1" }],
      orders: { "O-APPROVED": { status: "APPROVED" } },
    });

    const counts = await service.reconcileStuckCaptures({ olderThanMinutes: 60, limit: 3 });

    assert.deepEqual(counts, { completed: 0, failed: 1, waiting: 0, errors: 0 });
    assert.equal(named(calls, "findStuckCapturing")[0]?.[2], 3);
    const [[, , response]] = named(calls, "failIfCapturing") as [
      [string, string, Record<string, unknown>],
    ];
    assert.equal(response["reason"], "capture_never_completed");
    assert.equal(named(calls, "findByIdForUpdate").length, 0);
  });
});
