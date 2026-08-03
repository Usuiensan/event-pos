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
    const catalog = JSON.parse(first) as { eventId: string; products: unknown[]; quickEntries: unknown[]; staffMembers: unknown[]; autoDiscountRules: unknown[] };
    expect(catalog).toMatchObject({ eventId: "demo-event-large" });
    expect(catalog.products).toHaveLength(160);
    expect(catalog.products.filter((product: { tabId?: string }) => product.tabId === "adult")).toHaveLength(20);
    expect(catalog.quickEntries).toHaveLength(2);
    expect(catalog.staffMembers).toHaveLength(2);
    expect(catalog.autoDiscountRules).toHaveLength(1);
  });
});
