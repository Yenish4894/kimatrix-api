import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { EntityManager } from "typeorm";
import type { Company } from "@/entities/Company";
import type { CompanyRepository } from "@/repositories/CompanyRepository";
import type { TokenRepository } from "@/repositories/TokenRepository";
import type { TrialIdentityRepository } from "@/repositories/TrialIdentityRepository";
import type { AuditEntry, AuditService } from "@/services/AuditService";
import type { SubscriptionService } from "@/services/SubscriptionService";
import type { TransactionRunner } from "@/utils/db";
import { AdminBanService } from "@/services/AdminBanService";
import { AdminTrialService } from "@/services/AdminTrialService";
import { closeEmailQueue } from "@/queues/email.queue";

/**
 * Admin ban/unban and trial extension, with every dependency faked.
 *
 * What is pinned: the order of the writes inside the transaction (billing stops before
 * the ban, the ban is cleared before entitlement is recomputed), that every write uses
 * the transaction's manager, and the audit rows — these are the admin actions whose
 * history had to be reconstructed from pm2 logs before they were audited.
 */

// The service modules import the BullMQ email queue, which connects to Redis on load.
after(async () => {
  await closeEmailQueue();
});

const tx = { tx: true } as unknown as EntityManager;
const db: TransactionRunner = {
  transaction: <T>(fn: (m: EntityManager) => Promise<T>): Promise<T> => fn(tx),
};
const actor = { id: "admin-1", email: "admin@example.com" };
const DAY = 86_400_000;

function company(overrides: Partial<Record<keyof Company, unknown>> = {}): Company {
  return {
    id: "co-1",
    name: "Acme Fuel",
    isActive: true,
    deactivatedAt: null,
    deactivationReason: null,
    isComped: false,
    compedUntil: null,
    subscriptionExpiresAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    subscriptionStatus: "active",
    owner: { id: "owner-1", email: "owner@example.com", emailVerifiedAt: new Date() },
    ...overrides,
  } as unknown as Company;
}

/** Records every call as [name, ...args] and checks each write used the tx manager. */
function recorder() {
  const calls: [string, ...unknown[]][] = [];
  const audits: AuditEntry[] = [];
  const auditService = {
    record: async (entry: AuditEntry, manager?: EntityManager) => {
      assert.equal(manager, tx, "audit row must be written in the same transaction");
      calls.push(["audit", entry.action]);
      audits.push(entry);
    },
  } as unknown as AuditService;
  return { calls, audits, auditService };
}

describe("AdminBanService.deactivateCompany", () => {
  it("stops billing, bans, revokes sessions and audits — in that order, in one transaction", async () => {
    const { calls, audits, auditService } = recorder();
    const target = company({ subscriptionStatus: "active", isActive: true });
    const companyRepository = {
      findByIdWithOwner: async (id: string, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["findByIdWithOwner", id]);
        return target;
      },
      setDeactivated: async (id: string, by: string, reason: string, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["setDeactivated", id, by, reason]);
      },
    } as unknown as CompanyRepository;
    const subscriptionService = {
      cancelForAdmin: async (id: string, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["cancelForAdmin", id]);
      },
    } as unknown as SubscriptionService;
    const tokenRepository = {
      revokeAllRefreshTokensForUser: async (userId: string, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["revokeAll", userId]);
      },
    } as unknown as TokenRepository;

    const service = new AdminBanService(
      companyRepository,
      subscriptionService,
      tokenRepository,
      auditService,
      db,
    );
    await service.deactivateCompany(actor, "co-1", "Trial abuse");

    assert.deepEqual(calls, [
      ["findByIdWithOwner", "co-1"],
      ["cancelForAdmin", "co-1"],
      ["setDeactivated", "co-1", "admin-1", "Trial abuse"],
      ["revokeAll", "owner-1"],
      ["audit", "company.ban"],
    ]);
    assert.deepEqual(audits[0], {
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      action: "company.ban",
      entityType: "company",
      entityId: "co-1",
      before: { subscriptionStatus: "active", isActive: true },
      after: { subscriptionStatus: "deactivated", isActive: false },
      note: "Trial abuse",
    });
  });

  it("bans an expired company (isActive=false) — the guard is deactivatedAt, not isActive", async () => {
    const { calls, auditService } = recorder();
    const companyRepository = {
      findByIdWithOwner: async () => company({ isActive: false, subscriptionStatus: "expired" }),
      setDeactivated: async () => calls.push(["setDeactivated"]),
    } as unknown as CompanyRepository;
    const service = new AdminBanService(
      companyRepository,
      { cancelForAdmin: async () => undefined } as unknown as SubscriptionService,
      { revokeAllRefreshTokensForUser: async () => undefined } as unknown as TokenRepository,
      auditService,
      db,
    );
    await service.deactivateCompany(actor, "co-1", "Chargeback");
    assert.ok(calls.some(([name]) => name === "setDeactivated"));
  });

  it("refuses an already-banned company without touching billing", async () => {
    const { calls, auditService } = recorder();
    const companyRepository = {
      findByIdWithOwner: async () => company({ deactivatedAt: new Date() }),
    } as unknown as CompanyRepository;
    const subscriptionService = {
      cancelForAdmin: async () => calls.push(["cancelForAdmin"]),
    } as unknown as SubscriptionService;
    const service = new AdminBanService(
      companyRepository,
      subscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    await assert.rejects(service.deactivateCompany(actor, "co-1", "again"), (err: Error) => {
      assert.match(err.message, /already deactivated/);
      return true;
    });
    assert.deepEqual(calls, []);
  });

  it("404s an unknown company", async () => {
    const { auditService } = recorder();
    const service = new AdminBanService(
      { findByIdWithOwner: async () => null } as unknown as CompanyRepository,
      {} as SubscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    await assert.rejects(service.deactivateCompany(actor, "nope", "x"), (err: Error) => {
      assert.match(err.message, /Company not found/);
      return true;
    });
  });
});

describe("AdminBanService.activateCompany", () => {
  it("clears the ban, then lets entitlement decide — an expired company gets NO access", async () => {
    const { calls, audits, auditService } = recorder();
    const bannedAt = new Date("2026-09-01T00:00:00Z");
    const target = company({
      deactivatedAt: bannedAt,
      deactivationReason: "Trial abuse",
      subscriptionExpiresAt: new Date(Date.now() - 5 * DAY),
    });
    const companyRepository = {
      findById: async (_id: string, m: EntityManager) => {
        assert.equal(m, tx);
        return target;
      },
      clearDeactivation: async (id: string, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["clearDeactivation", id]);
      },
      setEntitlementState: async (id: string, state: unknown, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["setEntitlementState", id, state]);
      },
    } as unknown as CompanyRepository;

    const service = new AdminBanService(
      companyRepository,
      {} as SubscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    const result = await service.activateCompany(actor, "co-1");

    assert.deepEqual(result, { status: "expired", hasAccess: false });
    assert.deepEqual(calls, [
      ["clearDeactivation", "co-1"],
      ["setEntitlementState", "co-1", { isActive: false, subscriptionStatus: "expired" }],
      ["audit", "company.unban"],
    ]);
    // The ban's reason is captured before the row forgets it.
    assert.deepEqual(audits[0]?.before, {
      bannedAt: bannedAt.toISOString(),
      bannedReason: "Trial abuse",
    });
    // The unban records its OWN note, not the ban's reason again.
    assert.equal(audits[0]?.note, "Ban lifted");
  });

  it("records the unban's own reason when one is given", async () => {
    const { audits, auditService } = recorder();
    const companyRepository = {
      findById: async () =>
        company({ deactivatedAt: new Date(), deactivationReason: "Trial abuse" }),
      clearDeactivation: async () => undefined,
      setEntitlementState: async () => undefined,
    } as unknown as CompanyRepository;
    const service = new AdminBanService(
      companyRepository,
      {} as SubscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    await service.activateCompany(actor, "co-1", "  Owner appealed; verified  ");
    assert.equal(audits[0]?.note, "Ban lifted: Owner appealed; verified");
    assert.equal((audits[0]?.before as { bannedReason: string }).bannedReason, "Trial abuse");
  });

  it("restores access for a company whose paid time is still running", async () => {
    const { auditService } = recorder();
    const companyRepository = {
      findById: async () =>
        company({
          deactivatedAt: new Date(),
          subscriptionExpiresAt: new Date(Date.now() + 10 * DAY),
        }),
      clearDeactivation: async () => undefined,
      setEntitlementState: async () => undefined,
    } as unknown as CompanyRepository;
    const service = new AdminBanService(
      companyRepository,
      {} as SubscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    assert.deepEqual(await service.activateCompany(actor, "co-1"), {
      status: "active",
      hasAccess: true,
    });
  });

  it("refuses a company that is not banned", async () => {
    const { calls, auditService } = recorder();
    const companyRepository = {
      findById: async () => company({ deactivatedAt: null }),
      clearDeactivation: async () => calls.push(["clearDeactivation"]),
    } as unknown as CompanyRepository;
    const service = new AdminBanService(
      companyRepository,
      {} as SubscriptionService,
      {} as TokenRepository,
      auditService,
      db,
    );
    await assert.rejects(service.activateCompany(actor, "co-1"), (err: Error) => {
      assert.match(err.message, /not deactivated/);
      return true;
    });
    assert.deepEqual(calls, []);
  });
});

describe("AdminTrialService.extendTrial", () => {
  function trialService(target: Company, newEnd: Date) {
    const { calls, audits, auditService } = recorder();
    const companyRepository = {
      findByIdWithOwner: async (_id: string, m: EntityManager) => {
        assert.equal(m, tx);
        return target;
      },
      extendTrial: async (
        params: { companyId: string; days: number; now: Date },
        m: EntityManager,
      ) => {
        assert.equal(m, tx);
        calls.push(["extendTrial", params.companyId, params.days]);
        return newEnd;
      },
      setEntitlementState: async (id: string, state: unknown, m: EntityManager) => {
        assert.equal(m, tx);
        calls.push(["setEntitlementState", id, state]);
      },
    } as unknown as CompanyRepository;
    const service = new AdminTrialService(
      companyRepository,
      {} as TrialIdentityRepository,
      auditService,
      db,
    );
    return { service, calls, audits };
  }

  it("extends, recomputes entitlement from the new end, and audits before/after", async () => {
    const newEnd = new Date(Date.now() + 7 * DAY);
    const { service, calls, audits } = trialService(
      company({ trialEndsAt: null, subscriptionStatus: "pending", isActive: false }),
      newEnd,
    );

    const result = await service.extendTrial("co-1", 7, actor);

    assert.deepEqual(result, { trialEndsAt: newEnd, status: "trialing", ownerEmailVerified: true });
    assert.deepEqual(calls, [
      ["extendTrial", "co-1", 7],
      ["setEntitlementState", "co-1", { isActive: true, subscriptionStatus: "trialing" }],
      ["audit", "company.trial_extend"],
    ]);
    assert.deepEqual(audits[0]?.before, { trialEndsAt: null, subscriptionStatus: "pending" });
    assert.deepEqual(audits[0]?.after, {
      trialEndsAt: newEnd.toISOString(),
      subscriptionStatus: "trialing",
      days: 7,
      ownerEmailVerified: true,
    });
    assert.equal(audits[0]?.note, null);
  });

  it("still grants to an unverified owner, but says no expiry notices will be sent", async () => {
    const { service, audits } = trialService(
      company({ owner: { id: "owner-1", email: "x@example.com", emailVerifiedAt: null } }),
      new Date(Date.now() + 3 * DAY),
    );
    const result = await service.extendTrial("co-1", 3, actor);
    assert.equal(result.ownerEmailVerified, false);
    assert.match(String(audits[0]?.note), /no expiry notices/);
  });

  it("refuses a banned company and writes nothing", async () => {
    const { service, calls } = trialService(
      company({ deactivatedAt: new Date() }),
      new Date(Date.now() + DAY),
    );
    await assert.rejects(service.extendTrial("co-1", 7, actor), (err: Error) => {
      assert.match(err.message, /Reactivate this company/);
      return true;
    });
    assert.deepEqual(calls, []);
  });
});
