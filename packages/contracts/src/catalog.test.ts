import { describe, expect, it } from "vitest";
import { exportEventCatalog, importEventCatalog, taxCategoryLabel, type EventCatalog } from "./catalog.js";

const sample = { eventId: "event-1", products: [{ productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10" as const, saleState: "on_sale" as const, thumbnailUrl: "/products/a001.webp" }], quickEntries: [{ id: "set-1", label: "新刊セット", components: [{ productCode: "A001", quantity: 2 }] }], staffMembers: [{ responsibleNumber: "001", displayName: "テスト管理者" }] };

describe("event catalog JSON", () => {
  it("商品ごとのreceiptNoteをimport/exportで保持し、文字列以外を拒否する", () => {
    const withNote = { ...sample, products: [{ ...sample.products[0], receiptNote: "一部予約\n会場限定" }] };
    expect(importEventCatalog(exportEventCatalog(withNote as EventCatalog)).products[0]?.receiptNote).toBe("一部予約\n会場限定");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], receiptNote: 123 }] }))).toThrow("receiptNote");
  });
  it("imports and exports event-scoped products and sets", () => expect(importEventCatalog(exportEventCatalog(sample))).toEqual(sample));
  it("rejects duplicate product codes and invalid prices", () => {
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [sample.products[0], sample.products[0]] }))).toThrow("重複");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], priceInclTax: -1 }] }))).toThrow("整数");
  });
  it("validates UPC-A and JAN/EAN-13 check digits and prefixes", () => {
    const externalProducts = [
      { ...sample.products[0], productCode: "036000291452" },
      { ...sample.products[0], productCode: "4901234567894" },
    ];
    expect(importEventCatalog(JSON.stringify({ ...sample, products: externalProducts, quickEntries: [] })).products.map((product) => product.productCode)).toEqual(["036000291452", "4901234567894"]);
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], productCode: "036000291453" }] }))).toThrow("チェックデジット");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], productCode: "1500000000004" }] }))).toThrow("GS1プレフィックス");
  });
  it("validates responsible number mappings", () => {
    expect(importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "002", displayName: "担当者", permissions: ["refund"] }] })).staffMembers?.[0]?.permissions).toEqual(["refund"]);
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "", displayName: "名無し" }] }))).toThrow("3桁");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "001", displayName: "A" }, { responsibleNumber: "001", displayName: "B" }] }))).toThrow("重複");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "002", displayName: "" }] }))).toThrow("displayName");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "002", displayName: "担当者", permissions: ["admin"] }] }))).toThrow("permissions");
  });
  it("imports customer welcome content", () => {
    const customerWelcome = { message: "新刊を頒布中です", circleName: "サークル名", space: "東A-01a", imageUrl: "/welcome.png" };
    expect(importEventCatalog(JSON.stringify({ ...sample, customerWelcome })).customerWelcome).toEqual(customerWelcome);
    expect(() => importEventCatalog(JSON.stringify({ ...sample, customerWelcome: { message: 123 } }))).toThrow("customerWelcome.message");
  });
  it("商品が存在しないタブまたは部門を参照する場合は拒否する", () => {
    const catalog = {
      ...sample,
      productTabs: [{ id: "general", label: "一般" }],
      departments: [{ departmentId: "main", code: "01", name: "本", settlementOwnerId: "owner", enabled: true }],
    };
    expect(() => importEventCatalog(JSON.stringify({ ...catalog, products: [{ ...sample.products[0], tabId: "missing" }] }))).toThrow("missing");
    expect(() => importEventCatalog(JSON.stringify({ ...catalog, products: [{ ...sample.products[0], departmentId: "missing" }] }))).toThrow("missing");
  });
  it("supports and labels all six tax categories", () => {
    const products = [
      { ...sample.products[0], productCode: "A010", taxCategory: "inclusive_10", taxRate: 10 },
      { ...sample.products[0], productCode: "A008", taxCategory: "inclusive_8", taxRate: 8 },
      { ...sample.products[0], productCode: "B010", taxCategory: "exclusive_10", taxRate: 10, priceExclTax: 100, priceInclTax: 110 },
      { ...sample.products[0], productCode: "B008", taxCategory: "exclusive_8", taxRate: 8, priceExclTax: 100, priceInclTax: 108 },
      { ...sample.products[0], productCode: "C000", taxCategory: "exempt", taxRate: 0 },
      { ...sample.products[0], productCode: "D000", taxCategory: "non_taxable", taxRate: 0 },
    ];
    const imported = importEventCatalog(JSON.stringify({ ...sample, products, quickEntries: [] }));
    expect(imported.products.map((product) => taxCategoryLabel(product.taxCategory))).toEqual(["税込10%", "税込8%", "税抜10%", "税抜8%", "非課税", "不課税"]);
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...products[2], priceInclTax: 109 }], quickEntries: [] }))).toThrow("110円");
  });
});
