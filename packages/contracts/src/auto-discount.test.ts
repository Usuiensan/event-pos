import { describe, expect, it } from "vitest";
import { calculateAutoDiscounts } from "./auto-discount.js";

describe("automatic discount", () => {
  it("applies a same-product pair repeatedly without reusing quantities", () => {
    const result = calculateAutoDiscounts(new Map([["A", 5]]), [{ id: "pair", label: "2個値引き", requiredProducts: [{ productCode: "A", quantity: 2 }], discountYen: 100 }]);
    expect(result).toEqual([{ ruleId: "pair", label: "2個値引き", discountYen: 200, applications: 2 }]);
  });

  it("selects the combination with the largest discount", () => {
    const result = calculateAutoDiscounts(new Map([["A", 1], ["B", 1], ["C", 1]]), [
      { id: "ab", label: "A+B", requiredProducts: [{ productCode: "A", quantity: 1 }, { productCode: "B", quantity: 1 }], discountYen: 100 },
      { id: "ac", label: "A+C", requiredProducts: [{ productCode: "A", quantity: 1 }, { productCode: "C", quantity: 1 }], discountYen: 200 },
    ]);
    expect(result).toEqual([{ ruleId: "ac", label: "A+C", discountYen: 200, applications: 1 }]);
  });
});
