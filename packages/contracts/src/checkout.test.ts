import { describe, expect, it } from "vitest";
import { calculateSale, SaleCalculationError, type SaleCalculationLineInput } from "./checkout.js";

const line = (overrides: Partial<SaleCalculationLineInput> = {}): SaleCalculationLineInput => ({ lineId: "line-1", lineNo: 1, productCode: "00000001", name: "商品", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", quantity: 1, status: "active", ...overrides });

describe("server-side sale calculation", () => {
  it("uses purchase-favouring floor for 0% and 100% manual rate discounts", () => {
    expect(calculateSale([line({ priceInclTax: 101, manualDiscount: { kind: "rate", value: 0 } })]).totalYen).toBe(101);
    const free = calculateSale([line({ priceInclTax: 101, manualDiscount: { kind: "rate", value: 100 } })]);
    expect(free.totalYen).toBe(0);
    expect(free.discountTotalYen).toBe(101);
  });

  it("rejects over-100% rates and amount discounts above the target", () => {
    expect(() => calculateSale([line({ manualDiscount: { kind: "rate", value: 101 } })])).toThrow(SaleCalculationError);
    expect(() => calculateSale([line({ manualDiscount: { kind: "amount", value: 111 } })])).toThrow("対象額");
  });

  it("applies an automatic discount without reusing quantity tokens", () => {
    const rules = [{ id: "pair", label: "2個値引", requiredProducts: [{ productCode: "00000001", quantity: 2 }], discountYen: 25 }];
    const sale = calculateSale([line({ quantity: 3 })], rules);
    expect(sale.discounts).toMatchObject([{ kind: "auto", amountYen: 25 }]);
    expect(sale.totalYen).toBe(305);
  });

  it("allows a 100% manual discount after an automatic discount without going negative", () => {
    const rules = [{ id: "pair", label: "2個値引", requiredProducts: [{ productCode: "00000001", quantity: 2 }], discountYen: 20 }];
    const sale = calculateSale([line({ quantity: 2, manualDiscount: { kind: "rate", value: 100 } })], rules);
    expect(sale.discounts).toMatchObject([{ kind: "auto", amountYen: 20 }, { kind: "manual", amountYen: 200 }]);
    expect(sale.totalYen).toBe(0);
  });

  it("rounds tax once per rate after integer discount allocation", () => {
    const sale = calculateSale([
      line({ lineId: "ten", lineNo: 1, priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", manualDiscount: { kind: "amount", value: 1 } }),
      line({ lineId: "eight", lineNo: 2, productCode: "00000002", priceInclTax: 108, taxRate: 8, taxCategory: "inclusive_8" }),
    ]);
    expect(sale.taxSummaries).toEqual([
      { taxRateBps: 1000, taxableGrossYen: 110, discountAllocatedYen: 1, taxableNetYen: 109, taxAmountYen: 9, roundingMode: "floor" },
      { taxRateBps: 800, taxableGrossYen: 108, discountAllocatedYen: 0, taxableNetYen: 108, taxAmountYen: 8, roundingMode: "floor" },
    ]);
    expect(sale.lines.reduce((sum, item) => sum + item.taxYen, 0)).toBe(17);
  });

  it("records no-charge distribution as a zero-yen calculated sale", () => {
    const sale = calculateSale([line()], [], true);
    expect(sale.totalYen).toBe(0);
    expect(sale.discounts).toMatchObject([{ kind: "no_charge", amountYen: 110 }]);
    expect(sale.taxTotalYen).toBe(0);
  });
});
