import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REGISTRATION_ACCEPTED,
  REGISTRATION_NOTICE_TTL_SECONDS,
  isEmailUniqueViolation,
  registrationNoticeKey,
  runRegistration,
  sendRegistrationAttemptNotice,
  type ExistingAccount,
  type RegistrationFlowDeps,
  type RegistrationNoticeDeps,
} from "@/utils/registrationFlow";

const EXISTING: ExistingAccount = {
  id: "u-1",
  email: "owner@example.com",
  isActive: true,
  userType: "company",
};

/** Lets the fire-and-forget email work run before assertions. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness(opts: {
  existing?: ExistingAccount | null;
  otherConflict?: Error;
  insertError?: unknown;
  /** What a lookup outside the transaction sees (the race path). */
  existingAfterRace?: ExistingAccount | null;
}) {
  const calls = { inserts: 0, verifications: [] as string[], notices: [] as ExistingAccount[] };
  const deps: RegistrationFlowDeps<"tx"> = {
    transaction: (work) => work("tx"),
    assertOtherIdentifiersFree: async () => {
      if (opts.otherConflict) throw opts.otherConflict;
    },
    findAccountByEmail: async (tx) =>
      tx ? (opts.existing ?? null) : (opts.existingAfterRace ?? null),
    insertAccount: async () => {
      if (opts.insertError) throw opts.insertError;
      calls.inserts += 1;
      return { userId: "new-user" };
    },
    sendVerification: async (userId) => {
      calls.verifications.push(userId);
    },
    notifyExistingAccount: async (account) => {
      calls.notices.push(account);
    },
    logError: () => undefined,
  };
  return { deps, calls };
}

describe("runRegistration — the response never depends on whether the email is taken", () => {
  it("a new address creates the account and sends the verification link", async () => {
    const { deps, calls } = harness({ existing: null });
    const res = await runRegistration(deps);
    await flush();
    assert.deepEqual(res, { status: "check_email" });
    assert.equal(calls.inserts, 1);
    assert.deepEqual(calls.verifications, ["new-user"]);
    assert.equal(calls.notices.length, 0);
  });

  it("a taken address gets the identical response, inserts nothing, and notifies the owner once", async () => {
    const created = await runRegistration(harness({ existing: null }).deps);
    const { deps, calls } = harness({ existing: EXISTING });
    const taken = await runRegistration(deps);
    await flush();
    assert.deepEqual(taken, created);
    assert.deepEqual(JSON.stringify(taken), JSON.stringify(REGISTRATION_ACCEPTED));
    assert.equal(calls.inserts, 0);
    assert.equal(calls.verifications.length, 0);
    assert.deepEqual(calls.notices, [EXISTING]);
  });

  it("a username/registration-number conflict wins regardless of the email", async () => {
    const conflict = new Error("username taken");
    for (const existing of [null, EXISTING]) {
      const { deps, calls } = harness({ existing, otherConflict: conflict });
      await assert.rejects(runRegistration(deps), conflict);
      await flush();
      assert.equal(calls.inserts, 0);
      assert.equal(calls.notices.length, 0, "no notice when the request was refused");
    }
  });

  it("losing the insert race on users.email answers neutrally", async () => {
    const race = { code: "23505", constraint: "UQ_97672ac88f789774dd47f7c8be3" };
    const { deps, calls } = harness({
      existing: null,
      insertError: race,
      existingAfterRace: EXISTING,
    });
    assert.deepEqual(await runRegistration(deps), { status: "check_email" });
    await flush();
    assert.deepEqual(calls.notices, [EXISTING]);
    assert.equal(calls.verifications.length, 0);
  });

  it("other unique violations still surface", async () => {
    const race = { code: "23505", constraint: "UQ_fe0bb3f6520ee0469504521e710" };
    const { deps } = harness({ existing: null, insertError: race });
    await assert.rejects(runRegistration(deps), (e) => e === race);
  });

  it("email failures never fail the request", async () => {
    const { deps } = harness({ existing: EXISTING });
    deps.notifyExistingAccount = async () => {
      throw new Error("redis down");
    };
    assert.deepEqual(await runRegistration(deps), { status: "check_email" });
    await flush();
  });
});

describe("isEmailUniqueViolation", () => {
  it("recognises the constraint, the TypeORM wrapper and the detail fallback", () => {
    assert.equal(
      isEmailUniqueViolation({ code: "23505", constraint: "UQ_97672ac88f789774dd47f7c8be3" }),
      true,
    );
    assert.equal(
      isEmailUniqueViolation({
        driverError: { code: "23505", detail: "Key (email)=(a@b.c) already exists." },
      }),
      true,
    );
    assert.equal(
      isEmailUniqueViolation({ code: "23505", detail: "Key (username)=(x) already exists." }),
      false,
    );
    assert.equal(isEmailUniqueViolation({ code: "23503" }), false);
    assert.equal(isEmailUniqueViolation(null), false);
  });
});

describe("sendRegistrationAttemptNotice — deduped per address", () => {
  function noticeHarness() {
    const keys = new Map<string, number>();
    const sent: { to: string; subject: string; text: string }[] = [];
    const deps: RegistrationNoticeDeps = {
      claimOnce: async (key, ttl) => {
        if (keys.has(key)) return false;
        keys.set(key, ttl);
        return true;
      },
      release: async (key) => {
        keys.delete(key);
      },
      enqueue: async (to, rendered) => {
        sent.push({ to, subject: rendered.subject, text: rendered.text });
      },
      frontendBaseUrl: "https://kimates.com/",
    };
    return { deps, keys, sent };
  }

  it("sends once, then dedupes repeats for an hour, including differently-cased input", async () => {
    const { deps, keys, sent } = noticeHarness();
    assert.equal(await sendRegistrationAttemptNotice(EXISTING, deps), "sent");
    assert.equal(await sendRegistrationAttemptNotice(EXISTING, deps), "deduped");
    assert.equal(
      await sendRegistrationAttemptNotice({ ...EXISTING, email: "Owner@Example.com" }, deps),
      "deduped",
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.to, "owner@example.com");
    assert.match(sent[0]!.text, /https:\/\/kimates\.com\/login/);
    assert.match(sent[0]!.text, /https:\/\/kimates\.com\/forgot-password/);
    assert.match(sent[0]!.text, /ignore this email/);
    assert.deepEqual([...keys.values()], [REGISTRATION_NOTICE_TTL_SECONDS]);
  });

  it("the Redis key never contains the address", () => {
    const key = registrationNoticeKey("owner@example.com");
    assert.doesNotMatch(key, /owner|example/);
    assert.equal(key, registrationNoticeKey(" OWNER@example.com "));
  });

  it("skips inactive accounts and the platform admin", async () => {
    const { deps, sent } = noticeHarness();
    assert.equal(
      await sendRegistrationAttemptNotice({ ...EXISTING, isActive: false }, deps),
      "skipped",
    );
    assert.equal(
      await sendRegistrationAttemptNotice({ ...EXISTING, userType: "super_admin" }, deps),
      "skipped",
    );
    assert.equal(sent.length, 0);
  });

  it("releases the claim when the enqueue fails, so the next attempt can notify", async () => {
    const { deps, keys } = noticeHarness();
    const enqueue = deps.enqueue;
    deps.enqueue = async () => {
      throw new Error("queue down");
    };
    await assert.rejects(sendRegistrationAttemptNotice(EXISTING, deps));
    assert.equal(keys.size, 0);
    deps.enqueue = enqueue;
    assert.equal(await sendRegistrationAttemptNotice(EXISTING, deps), "sent");
  });
});
