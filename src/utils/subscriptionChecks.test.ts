import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saleMatchesPlan, subscriptionBelongsTo } from "@/utils/paypalBilling";

describe("saleMatchesPlan", () => {
  const plan = { price: "29.99", currency: "USD" };

  it("credits a sale that paid the plan's price in its currency", () => {
    assert.ok(saleMatchesPlan({ amount: "29.99", currency: "USD" }, plan));
    assert.ok(
      saleMatchesPlan({ amount: "10", currency: "usd" }, { price: "10.00", currency: "USD" }),
    );
  });

  it("refuses a different amount, however close", () => {
    assert.ok(!saleMatchesPlan({ amount: "29.98", currency: "USD" }, plan));
    assert.ok(!saleMatchesPlan({ amount: "0.00", currency: "USD" }, plan));
    assert.ok(!saleMatchesPlan({ amount: "59.98", currency: "USD" }, plan));
  });

  it("refuses the right number in the wrong currency", () => {
    assert.ok(!saleMatchesPlan({ amount: "29.99", currency: "ZAR" }, plan));
  });

  it("refuses anything it cannot parse", () => {
    assert.ok(!saleMatchesPlan({ amount: undefined, currency: "USD" }, plan));
    assert.ok(!saleMatchesPlan({ amount: "29.99", currency: undefined }, plan));
    assert.ok(!saleMatchesPlan({ amount: "abc", currency: "USD" }, plan));
  });
});

describe("subscriptionBelongsTo", () => {
  it("accepts the owner, with or without PayPal's custom_id", () => {
    assert.ok(subscriptionBelongsTo("co-1", "co-1", "co-1"));
    assert.ok(subscriptionBelongsTo("co-1", undefined, "co-1"));
    assert.ok(subscriptionBelongsTo("co-1", "", "co-1"));
  });

  it("refuses another company even when PayPal omits custom_id", () => {
    assert.ok(!subscriptionBelongsTo("co-2", undefined, "co-1"));
  });

  it("refuses when we have no record of the subscription", () => {
    assert.ok(!subscriptionBelongsTo(null, "co-1", "co-1"));
    assert.ok(!subscriptionBelongsTo(undefined, undefined, "co-1"));
  });

  it("refuses when PayPal names a different company", () => {
    assert.ok(!subscriptionBelongsTo("co-1", "co-2", "co-1"));
  });
});
