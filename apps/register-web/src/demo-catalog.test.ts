import { validateEventCatalog } from "@event-pos/contracts";
import { describe, expect, it } from "vitest";
import { demoCatalog } from "./demo-catalog.js";

describe("demoCatalog", () => {
  it("8ジャンルに20商品ずつ収録する", () => {
    const catalog = validateEventCatalog(demoCatalog);

    expect(catalog.productTabs?.map((tab) => tab.label)).toEqual([
      "野菜", "青果", "鮮魚", "精肉", "惣菜", "ギフト", "本", "成人向",
    ]);
    expect(catalog.products).toHaveLength(160);
    for (const tab of catalog.productTabs ?? []) {
      expect(catalog.products.filter((product) => product.tabId === tab.id), tab.label).toHaveLength(20);
    }
  });

  it("成人向商品には18歳確認を設定する", () => {
    const adultProducts = demoCatalog.products.filter((product) => product.tabId === "adult");

    expect(adultProducts).toHaveLength(20);
    expect(adultProducts.every((product) => product.ageCheck === "18")).toBe(true);
  });
});
