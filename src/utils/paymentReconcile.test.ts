import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideStuckCapture, type PaypalOrderView } from "@/utils/paymentReconcile";

const withCapture = (orderStatus: string, captureStatus: string): PaypalOrderView => ({
  status: orderStatus,
  purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: captureStatus }] } }],
});

describe("decideStuckCapture", () => {
  it("completes a payment PayPal captured", () => {
    assert.deepEqual(decideStuckCapture(withCapture("COMPLETED", "COMPLETED")), {
      action: "complete",
    });
  });

  it("waits on a capture PayPal is still clearing, rather than granting early", () => {
    assert.equal(decideStuckCapture(withCapture("COMPLETED", "PENDING")).action, "wait");
  });

  it("fails a declined or failed capture", () => {
    assert.equal(decideStuckCapture(withCapture("COMPLETED", "DECLINED")).action, "fail");
    assert.equal(decideStuckCapture(withCapture("COMPLETED", "FAILED")).action, "fail");
  });

  it("fails a capture that was refunded before we recorded it", () => {
    assert.equal(decideStuckCapture(withCapture("COMPLETED", "REFUNDED")).action, "fail");
  });

  it("closes an approved order whose capture never happened, never charging it late", () => {
    const d = decideStuckCapture({ status: "APPROVED", purchase_units: [{}] });
    assert.deepEqual(d, { action: "fail", reason: "capture_never_completed" });
  });

  it("fails an order PayPal doesn't know, and a voided one", () => {
    assert.equal(decideStuckCapture(null).action, "fail");
    assert.equal(decideStuckCapture({ status: "VOIDED" }).action, "fail");
  });

  it("leaves anything it doesn't recognise for a human", () => {
    assert.equal(decideStuckCapture({ status: "COMPLETED" }).action, "wait");
    assert.equal(decideStuckCapture({}).action, "wait");
    assert.equal(decideStuckCapture(withCapture("COMPLETED", "SOMETHING_NEW")).action, "wait");
  });
});
