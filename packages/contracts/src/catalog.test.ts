import { describe, expect, it } from "vitest";
import { exportEventCatalog, importEventCatalog } from "./catalog.js";

const sample = { eventId: "event-1", products: [{ productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, saleState: "on_sale" as const, thumbnailUrl: "/products/a001.webp" }], quickEntries: [{ id: "set-1", label: "新刊セット", components: [{ productCode: "A001", quantity: 2 }] }], staffMembers: [{ responsibleNumber: "001", displayName: "テスト管理者" }] };

describe("event catalog JSON", () => {
  it("imports and exports event-scoped products and sets", () => expect(importEventCatalog(exportEventCatalog(sample))).toEqual(sample));
  it("rejects duplicate product codes and invalid prices", () => {
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [sample.products[0], sample.products[0]] }))).toThrow("重複");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], priceInclTax: -1 }] }))).toThrow("整数");
  });
  it("validates responsible number mappings", () => {
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "", displayName: "名無し" }] }))).toThrow("3桁");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "001", displayName: "A" }, { responsibleNumber: "001", displayName: "B" }] }))).toThrow("重複");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, staffMembers: [{ responsibleNumber: "002", displayName: "" }] }))).toThrow("displayName");
  });
});
