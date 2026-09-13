import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emailDomainForLog } from "@/utils/redact";

describe("emailDomainForLog", () => {
  it("keeps only the domain", () => {
    assert.equal(emailDomainForLog("Asha.Naidoo@Example.CO.ZA"), "example.co.za");
    assert.ok(!emailDomainForLog("asha@example.com").includes("asha"));
  });

  it("uses the last @, so a quoted local part cannot leak into the log", () => {
    assert.equal(emailDomainForLog('"a@b"@example.com'), "example.com");
  });

  it("never echoes a malformed value back", () => {
    assert.equal(emailDomainForLog("no-at-sign"), "(invalid)");
    assert.equal(emailDomainForLog("trailing@"), "(invalid)");
  });
});
