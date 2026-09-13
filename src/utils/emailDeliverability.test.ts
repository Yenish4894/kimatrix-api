import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AppError } from "@/middleware/errorHandler";
import {
  assertEmailsDeliverable,
  classifyDnsError,
  createDeliverabilityChecker,
  editDistance,
  isDisposableDomain,
  suggestDomain,
  suggestEmailCorrection,
  type DeliverabilityChecker,
  type DnsResolver,
} from "./emailDeliverability";

const dnsError = (code: string): Error => Object.assign(new Error(code), { code });

type Answer<T> = T | Error | "hang";

/** A resolver whose three answers are scripted, and which counts its calls. */
function scriptedResolver(
  mx: Answer<{ exchange: string; priority: number }[]>,
  a4: Answer<string[]> = dnsError("ENODATA"),
  a6: Answer<string[]> = dnsError("ENODATA"),
): DnsResolver & { calls: { mx: number; a4: number; a6: number } } {
  const calls = { mx: 0, a4: 0, a6: 0 };
  const answer = <T>(a: Answer<T>): Promise<T> =>
    a === "hang"
      ? new Promise<T>(() => undefined)
      : a instanceof Error
        ? Promise.reject(a)
        : Promise.resolve(a);
  return {
    calls,
    resolveMx: () => {
      calls.mx++;
      return answer(mx);
    },
    resolve4: () => {
      calls.a4++;
      return answer(a4);
    },
    resolve6: () => {
      calls.a6++;
      return answer(a6);
    },
  };
}

const MX_OK = [{ exchange: "mx.example.co.za", priority: 10 }];

describe("typo suggestion", () => {
  it("corrects the address that took the mailbox down", () => {
    assert.equal(suggestEmailCorrection("isorathiya21@gmai.com"), "isorathiya21@gmail.com");
  });

  it("corrects every listed misspelling", () => {
    const cases: [string, string][] = [
      ["gmai.com", "gmail.com"],
      ["gmial.com", "gmail.com"],
      ["gamil.com", "gmail.com"],
      ["gmail.co", "gmail.com"],
      ["gmail.con", "gmail.com"],
      ["gmaill.com", "gmail.com"],
      ["gmail.co.in", "gmail.com"],
      ["hotmial.com", "hotmail.com"],
      ["yaho.com", "yahoo.com"],
      ["outlok.com", "outlook.com"],
      ["iclod.com", "icloud.com"],
      ["live.con", "live.com"],
      ["rediffmial.com", "rediffmail.com"],
    ];
    for (const [typo, fixed] of cases) assert.equal(suggestDomain(typo), fixed, typo);
  });

  it("catches unlisted one-edit slips, including transpositions", () => {
    assert.equal(suggestDomain("gmaik.com"), "gmail.com");
    assert.equal(suggestDomain("hotmali.com"), "hotmail.com");
    assert.equal(suggestDomain("rediffmsil.com"), "rediffmail.com");
  });

  it("allows two edits only on a long domain with the same TLD", () => {
    assert.equal(suggestDomain("hoymaol.com"), "hotmail.com");
    // Two edits from yahoo.com / live.com but a genuine domain with a different TLD.
    assert.equal(suggestDomain("yahoo.ca"), null);
    assert.equal(suggestDomain("live.ca"), null);
  });

  it("leaves real domains alone, including near-neighbours of the big providers", () => {
    for (const domain of [
      "gmail.com",
      "ymail.com",
      "mail.com",
      "email.com",
      "yahoo.co.in",
      "cloud.com",
      "hive.com",
      "five.com",
      "kimates.com",
      "acme.co.za",
      "techeniac.com",
    ]) {
      assert.equal(suggestDomain(domain), null, domain);
    }
  });

  it("is case-insensitive and keeps the local part as typed", () => {
    assert.equal(suggestEmailCorrection("John.Doe@GMIAL.com"), "John.Doe@gmail.com");
  });

  it("returns null for something that is not an address", () => {
    assert.equal(suggestEmailCorrection("no-at-sign"), null);
    assert.equal(suggestEmailCorrection("trailing@"), null);
  });

  it("measures edit distance with transpositions counted once", () => {
    assert.equal(editDistance("gmial", "gmail"), 1);
    assert.equal(editDistance("gmail", "gmail"), 0);
    assert.equal(editDistance("", "abc"), 3);
  });
});

describe("disposable matching", () => {
  const list = new Set(["mailinator.com", "10minutemail.com"]);

  it("matches the domain and any subdomain of it", () => {
    assert.equal(isDisposableDomain("mailinator.com", list), true);
    assert.equal(isDisposableDomain("x.mailinator.com", list), true);
    assert.equal(isDisposableDomain("a.b.MAILINATOR.com", list), true);
  });

  it("does not match lookalikes or a listed domain used as a prefix", () => {
    assert.equal(isDisposableDomain("notmailinator.com", list), false);
    assert.equal(isDisposableDomain("mailinator.com.example.org", list), false);
    assert.equal(isDisposableDomain("com", list), false);
  });

  it("uses the bundled list by default", () => {
    assert.equal(isDisposableDomain("mailinator.com"), true);
    assert.equal(isDisposableDomain("gmail.com"), false);
  });
});

describe("DNS error classification", () => {
  it("treats only definitive answers as negative", () => {
    for (const code of ["ENOTFOUND", "ENODATA", "NXDOMAIN"]) {
      assert.equal(classifyDnsError(dnsError(code)), "negative", code);
    }
  });

  it("treats resolver trouble as transient", () => {
    for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED"]) {
      assert.equal(classifyDnsError(dnsError(code)), "transient", code);
    }
    assert.equal(classifyDnsError(new Error("no code")), "transient");
    assert.equal(classifyDnsError(null), "transient");
  });
});

describe("checkEmailDeliverable with an injected resolver", () => {
  it("accepts a domain with an MX record", async () => {
    const check = createDeliverabilityChecker({ resolver: scriptedResolver(MX_OK) });
    assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
  });

  it("accepts a domain with no MX but an A record (implicit MX)", async () => {
    const r = scriptedResolver(dnsError("ENODATA"), ["203.0.113.7"]);
    const check = createDeliverabilityChecker({ resolver: r });
    assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
  });

  it("accepts an AAAA-only domain", async () => {
    const r = scriptedResolver([], dnsError("ENODATA"), ["2001:db8::1"]);
    const check = createDeliverabilityChecker({ resolver: r });
    assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
  });

  it("rejects a domain that does not exist", async () => {
    const r = scriptedResolver(dnsError("ENOTFOUND"), dnsError("ENOTFOUND"), dnsError("ENOTFOUND"));
    const check = createDeliverabilityChecker({ resolver: r });
    const result = await check("owner@no-such-shop.co.za");
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "no_mail_server");
    assert.match(!result.ok ? result.message : "", /no-such-shop\.co\.za/);
  });

  it("rejects an empty MX list with no address records", async () => {
    const check = createDeliverabilityChecker({ resolver: scriptedResolver([]) });
    const result = await check("owner@parked.co.za");
    assert.equal(!result.ok && result.reason, "no_mail_server");
  });

  it("rejects a null MX without falling back to A", async () => {
    const r = scriptedResolver([{ exchange: "", priority: 0 }], ["203.0.113.7"]);
    const check = createDeliverabilityChecker({ resolver: r });
    const result = await check("owner@nomail.co.za");
    assert.equal(!result.ok && result.reason, "no_mail_server");
    assert.equal(r.calls.a4, 0);
  });

  it("fails open on SERVFAIL", async () => {
    const check = createDeliverabilityChecker({
      resolver: scriptedResolver(dnsError("ESERVFAIL")),
    });
    assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
  });

  it("fails open when the MX is missing but the A lookup times out", async () => {
    const r = scriptedResolver(dnsError("ENODATA"), dnsError("ETIMEOUT"));
    const check = createDeliverabilityChecker({ resolver: r });
    assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
  });

  it("fails open when the resolver never answers", async () => {
    // The checker's own timer is unref'd; this one keeps the test process alive.
    const keepAlive = setTimeout(() => undefined, 5_000);
    try {
      const check = createDeliverabilityChecker({
        resolver: scriptedResolver("hang"),
        timeoutMs: 30,
      });
      assert.deepEqual(await check("owner@shop.co.za"), { ok: true });
    } finally {
      clearTimeout(keepAlive);
    }
  });

  it("caches definitive answers for the TTL, then asks again", async () => {
    let clock = 0;
    const r = scriptedResolver(MX_OK);
    const check = createDeliverabilityChecker({ resolver: r, now: () => clock, cacheTtlMs: 1_000 });
    await check("a@shop.co.za");
    await check("b@shop.co.za");
    assert.equal(r.calls.mx, 1);
    clock = 1_001;
    await check("c@shop.co.za");
    assert.equal(r.calls.mx, 2);
  });

  it("does not cache an inconclusive answer", async () => {
    const r = scriptedResolver(dnsError("ESERVFAIL"));
    const check = createDeliverabilityChecker({ resolver: r });
    await check("a@shop.co.za");
    await check("b@shop.co.za");
    assert.equal(r.calls.mx, 2);
  });

  it("skips DNS for the big providers", async () => {
    const r = scriptedResolver(dnsError("ENOTFOUND"));
    const check = createDeliverabilityChecker({ resolver: r });
    assert.deepEqual(await check("owner@gmail.com"), { ok: true });
    assert.equal(r.calls.mx, 0);
  });

  it("reports a typo with the full suggested address, before touching DNS", async () => {
    const r = scriptedResolver(MX_OK);
    const check = createDeliverabilityChecker({ resolver: r });
    assert.deepEqual(await check("isorathiya21@gmai.com"), {
      ok: false,
      reason: "typo",
      message: "Did you mean isorathiya21@gmail.com?",
      suggestion: "isorathiya21@gmail.com",
    });
    assert.equal(r.calls.mx, 0);
  });

  it("reports a disposable domain before touching DNS", async () => {
    const r = scriptedResolver(MX_OK);
    const check = createDeliverabilityChecker({ resolver: r });
    const result = await check("bot@x.mailinator.com");
    assert.equal(!result.ok && result.reason, "disposable");
    assert.equal(r.calls.mx, 0);
  });
});

describe("assertEmailsDeliverable", () => {
  const fake: DeliverabilityChecker = async (email) =>
    email.endsWith("@gmai.com")
      ? {
          ok: false,
          reason: "typo",
          message: "Did you mean x@gmail.com?",
          suggestion: "x@gmail.com",
        }
      : { ok: true };

  it("throws a VALIDATION_ERROR with one field detail per bad address", async () => {
    await assert.rejects(
      assertEmailsDeliverable(
        [
          { field: "email", value: "x@gmai.com" },
          { field: "contactEmail", value: "ok@shop.co.za" },
        ],
        fake,
      ),
      (err: unknown) => {
        assert.ok(err instanceof AppError);
        assert.equal(err.statusCode, 400);
        assert.equal(err.code, "VALIDATION_ERROR");
        assert.equal(err.message, "Did you mean x@gmail.com?");
        assert.deepEqual(err.details, [{ field: "email", message: "Did you mean x@gmail.com?" }]);
        return true;
      },
    );
  });

  it("uses a generic top-level message when several fields fail", async () => {
    await assert.rejects(
      assertEmailsDeliverable(
        [
          { field: "email", value: "x@gmai.com" },
          { field: "contactEmail", value: "y@gmai.com" },
        ],
        fake,
      ),
      (err: unknown) =>
        err instanceof AppError &&
        err.message === "Please check the highlighted email addresses." &&
        err.details?.length === 2,
    );
  });

  it("passes when every address is fine and ignores empty values", async () => {
    await assertEmailsDeliverable(
      [
        { field: "email", value: "ok@shop.co.za" },
        { field: "contactEmail", value: undefined },
      ],
      fake,
    );
  });
});
