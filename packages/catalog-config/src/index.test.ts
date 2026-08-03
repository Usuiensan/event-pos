import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog, deterministicCatalogJson } from "./index.js";

describe("分割イベント設定", () => {
  it("demo設定を決定的な既存互換カタログへ統合する", async () => {
    const directory = resolve(import.meta.dirname, "../../../event-config/demo");
    const first = deterministicCatalogJson(await buildCatalog(directory));
    const second = deterministicCatalogJson(await buildCatalog(directory));
    expect(first).toBe(second);
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(second).digest("hex"));
    const catalog = JSON.parse(first) as { eventId: string; products: unknown[]; quickEntries: unknown[]; staffMembers: unknown[]; productTabs: Array<{ label: string }>; autoDiscountRules: unknown[] };
    expect(catalog).toMatchObject({ eventId: "demo-event-large" });
    expect(catalog.products).toHaveLength(160);
    expect(catalog.products.filter((product: { tabId?: string }) => product.tabId === "adult")).toHaveLength(20);
    expect(catalog.quickEntries).toHaveLength(2);
    expect(catalog.staffMembers).toHaveLength(2);
    expect(catalog.autoDiscountRules).toHaveLength(1);
    const builtProducts = catalog.products.map(({ internalToken: _token, ...product }: Record<string, unknown>) => product);
    const legacyProducts = demoCatalog.products.map(({ internalToken: _token, ...product }) => product);
    expect(builtProducts).toEqual(legacyProducts);
    expect(catalog.productTabs?.map((tab) => tab.label)).toEqual(["野菜", "青果", "鮮魚", "精肉", "惣菜", "ギフト", "本", "成人向"]);
    expect(catalog.quickEntries).toContainEqual({ id: "adult-new", label: "R18新刊 小説A", components: [{ productCode: "T0000141", quantity: 1 }], tabId: "adult" });
  });
});
