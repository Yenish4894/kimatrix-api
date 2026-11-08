import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBulkAnnouncementEmail } from "@/templates/bulkAnnouncement.template";

const base = { subject: "Holiday hours", body: "We close early on Friday." };

describe("renderBulkAnnouncementEmail footer", () => {
  it("tells a company owner they have an account and links to their settings", () => {
    const { html, text } = renderBulkAnnouncementEmail({ ...base, audience: "company" });
    assert.match(html, /your business has an account/);
    assert.match(html, /\/company\/settings/);
    assert.match(text, /your business has an account/);
  });

  it("defaults to the company footer when no audience is given", () => {
    const { html } = renderBulkAnnouncementEmail(base);
    assert.match(html, /your business has an account/);
  });

  it("never tells an outside address it has an account, or sends it to settings", () => {
    const { html, text } = renderBulkAnnouncementEmail({ ...base, audience: "external" });
    for (const out of [html, text]) {
      assert.doesNotMatch(out, /has an account/);
      assert.doesNotMatch(out, /company\/settings/);
      assert.match(out, /chose to send this message to you/);
      assert.match(out, /reply to this email/);
      assert.match(out, /info@kimates\.com/);
    }
  });

  it("keeps the message itself identical for both audiences", () => {
    const a = renderBulkAnnouncementEmail({ ...base, audience: "company" });
    const b = renderBulkAnnouncementEmail({ ...base, audience: "external" });
    assert.equal(a.subject, b.subject);
    assert.match(b.html, /We close early on Friday\./);
  });
});
