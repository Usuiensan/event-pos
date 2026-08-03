import { describe, expect, it } from "vitest";
import type { ProductDefinition } from "@event-pos/contracts";
import { findProductByManualCode } from "./product-code-input.js";

const products: ProductDefinition[] = [
  { productCode: "A1", name: "短い内部コード商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" },
  { productCode: "00000001", name: "8桁商品", priceInclTax: 200, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" },
];

describe("findProductByManualCode", () => {
  it("短い英数字の内部商品コードを前後空白を除いて完全一致検索する", () => {
    expect(findProductByManualCode(products, " A1 ")).toEqual(products[0]);
  });

  it("空欄と未知のコードは商品として扱わない", () => {
    expect(findProductByManualCode(products, "")).toBeUndefined();
    expect(findProductByManualCode(products, "A-1")).toBeUndefined();
  });
});
