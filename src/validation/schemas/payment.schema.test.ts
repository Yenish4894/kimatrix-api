import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createOrderSchema, createSpinOrderSchema } from "@/validation/schemas/payment.schema";

const PLAN_ID = "0b9a4c3e-6f1d-4e2a-9a55-2f1c8f0d7b10";

/**
 * Spin quantities decide how much PayPal charges, so the bounds are pinned here rather
 * than trusted to the number input on the billing page — the API is callable directly.
 */
describe("spin add-on order validation", () => {
  it("defaults a plan checkout to no spins", () => {
    const { value, error } = createOrderSchema.validate({ planId: PLAN_ID });
    assert.equal(error, undefined);
    assert.equal(value.spinQuantity, 0);
  });

  it("rejects negative, fractional and oversized checkout quantities", () => {
    for (const spinQuantity of [-1, 1.5, 101]) {
      assert.ok(
        createOrderSchema.validate({ planId: PLAN_ID, spinQuantity }).error,
        `checkout accepted ${spinQuantity}`,
      );
    }
  });

  it("requires at least one spin for a standalone purchase", () => {
    assert.ok(createSpinOrderSchema.validate({}).error, "accepted a missing quantity");
    for (const spinQuantity of [0, -1, 1.5, 101]) {
      assert.ok(
        createSpinOrderSchema.validate({ spinQuantity }).error,
        `add-on accepted ${spinQuantity}`,
      );
    }
    assert.equal(createSpinOrderSchema.validate({ spinQuantity: 100 }).error, undefined);
  });
});
