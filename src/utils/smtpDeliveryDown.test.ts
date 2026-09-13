import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isSmtpDeliveryDown, type SmtpSendOutcome } from "@/utils/smtpHealth";

const at = "2026-09-13T00:00:00.000Z";
const ok: SmtpSendOutcome = {
  ok: true,
  at,
  source: "job",
  responseCode: null,
  code: null,
  message: null,
  kind: null,
};
const fail = (kind: SmtpSendOutcome["kind"]): SmtpSendOutcome => ({
  ok: false,
  at,
  source: "job",
  responseCode: 554,
  code: "EENVELOPE",
  message: "refused",
  kind,
});

describe("isSmtpDeliveryDown", () => {
  it("is down only when the LAST send was a hard failure", () => {
    assert.equal(
      isSmtpDeliveryDown({ last: fail("hard"), lastSuccessAt: null, lastFailure: fail("hard") }),
      true,
    );
  });

  it("is not down after a later success, even with an older hard failure on record", () => {
    assert.equal(
      isSmtpDeliveryDown({ last: ok, lastSuccessAt: at, lastFailure: fail("hard") }),
      false,
    );
  });

  it("transient and recipient failures do not count", () => {
    assert.equal(
      isSmtpDeliveryDown({ last: fail("transient"), lastSuccessAt: null, lastFailure: null }),
      false,
    );
    assert.equal(
      isSmtpDeliveryDown({ last: fail("recipient"), lastSuccessAt: null, lastFailure: null }),
      false,
    );
  });

  it("nothing recorded is not down", () => {
    assert.equal(isSmtpDeliveryDown({ last: null, lastSuccessAt: null, lastFailure: null }), false);
  });
});
