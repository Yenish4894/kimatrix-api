import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSubscriptionNoticeEmail } from "@/templates/subscriptionNotice.template";
import { EXPIRY_RETENTION_DAYS } from "@/config/retention";

const PRE_EXPIRY = ["trial_ending", "subscription_ending"] as const;
const POST_EXPIRY = ["trial_ended", "subscription_ended"] as const;
const ALL = [...PRE_EXPIRY, ...POST_EXPIRY];

const render = (kind: (typeof ALL)[number], deadline = new Date(Date.now() + 20 * 3600_000)) =>
  renderSubscriptionNoticeEmail({
    kind,
    companyName: "Station Total Niamey",
    deadline,
    billingUrl: "https://kimates.com/company/billing",
    exportUrl: "https://kimates.com/company/export",
    retentionDays: EXPIRY_RETENTION_DAYS,
  });

describe("expiry notices — what each one is allowed to say", () => {
  for (const kind of PRE_EXPIRY) {
    it(`${kind} asks for the renewal and never suggests leaving`, () => {
      // Every one of these used to close with "if you'd rather stop here" or "if you'd
      // rather not continue" — an invitation to leave, inside the email whose whole job
      // is to keep the customer.
      const { text, html } = render(kind);
      for (const phrase of ["rather stop here", "rather not continue", "download"]) {
        assert.ok(!text.toLowerCase().includes(phrase), `${kind} text mentions "${phrase}"`);
        assert.ok(!html.toLowerCase().includes(phrase), `${kind} html mentions "${phrase}"`);
      }
    });
  }

  for (const kind of POST_EXPIRY) {
    it(`${kind} states the retention window and how to get the data`, () => {
      // After the deadline the customer has to be told what happens to their data and
      // how long they have to act.
      const { text } = render(kind);
      assert.ok(text.includes(`${EXPIRY_RETENTION_DAYS} days`), "retention window missing");
      assert.ok(/download/i.test(text), "no way to reach the data");
    });

    it(`${kind} still leads with renewing rather than leaving`, () => {
      const { text } = render(kind);
      assert.ok(!/rather not continue|rather stop here/i.test(text));
    });
  }

  for (const kind of ALL) {
    it(`${kind} always offers the billing link`, () => {
      assert.ok(render(kind).text.includes("https://kimates.com/company/billing"));
    });

    it(`${kind} produces a subject, and never an empty one`, () => {
      assert.ok(render(kind).subject.trim().length > 10);
    });
  }

  it("a plan about to expire does not say it 'renews'", () => {
    // "Your plan renews on 24 August" is the opposite of what is happening, and would
    // reassure exactly the customer who needs to act.
    assert.ok(!/renews/i.test(render("subscription_ending").subject));
    assert.ok(/expires/i.test(render("subscription_ending").subject));
  });

  it("says 'today' or 'tomorrow' on the pre-expiry reminders", () => {
    // The paid reminder is sent 24 hours out precisely so it can say this; "on 24
    // August" does not prompt anyone to act.
    assert.match(render("subscription_ending").subject, /today|tomorrow/);
    assert.match(render("trial_ending", new Date(Date.now() + 40 * 3600_000)).subject, /tomorrow/);
  });
});
