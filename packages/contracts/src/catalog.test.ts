import { describe, expect, it } from "vitest";
import { exportEventCatalog, importEventCatalog } from "./catalog.js";

const sample = { eventId: "event-1", products: [{ productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, saleState: "on_sale" as const }], quickEntries: [{ id: "set-1", label: "新刊セット", components: [{ productCode: "A001", quantity: 2 }] }] };

describe("event catalog JSON", () => {
  it("imports and exports event-scoped products and sets", () => expect(importEventCatalog(exportEventCatalog(sample))).toEqual(sample));
  it("rejects duplicate product codes and invalid prices", () => {
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [sample.products[0], sample.products[0]] }))).toThrow("重複");
    expect(() => importEventCatalog(JSON.stringify({ ...sample, products: [{ ...sample.products[0], priceInclTax: -1 }] }))).toThrow("整数");
  });
});
