import { describe, expect, it } from "vitest";
import type { ProductDefinition } from "@event-pos/contracts";
import { ageRequirement, isAgeRestricted } from "./age-requirement.js";

const product = (overrides: Partial<ProductDefinition>): ProductDefinition => ({
  productCode: "T0000001",
  name: "通常商品",
  priceInclTax: 100,
  taxRate: 10,
  taxCategory: "inclusive_10",
  saleState: "on_sale",
  ...overrides,
});

describe("年齢要件は ageCheck のみで決まる", () => {
  it("ageCheck が 18 の商品は 18歳以上", () => {
    expect(ageRequirement(product({ ageCheck: "18" }))).toBe(18);
    expect(isAgeRestricted(product({ ageCheck: "18" }))).toBe(true);
  });

  it("ageCheck が 20 の商品は 20歳以上", () => {
    expect(ageRequirement(product({ ageCheck: "20" }))).toBe(20);
    expect(isAgeRestricted(product({ ageCheck: "20" }))).toBe(true);
  });

  it("ageCheck が none の商品は商品名にかかわらず確認不要", () => {
    expect(ageRequirement(product({ ageCheck: "none", name: "日本酒のラベル図鑑" }))).toBeNull();
    expect(ageRequirement(product({ ageCheck: "none", name: "R18新刊 小説A" }))).toBeNull();
    expect(isAgeRestricted(product({ ageCheck: "none", name: "ビール" }))).toBe(false);
  });

  it("ageCheck 未指定の商品は商品名に「酒」を含んでも確認不要（F-049）", () => {
    expect(ageRequirement(product({ name: "日本酒のラベル図鑑" }))).toBeNull();
    expect(isAgeRestricted(product({ name: "日本酒のラベル図鑑" }))).toBe(false);
  });

  it("ageCheck 未指定の商品は商品名に R18 やビールを含んでも確認不要（F-049）", () => {
    expect(ageRequirement(product({ name: "R18新刊 小説A" }))).toBeNull();
    expect(ageRequirement(product({ name: "地ビール図鑑" }))).toBeNull();
    expect(ageRequirement(product({ name: "通常商品" }))).toBeNull();
  });
});
