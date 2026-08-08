import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type PosDatabase } from "./db.js";
import { fetchYahooShoppingCandidates } from "./yahoo-shopping.js";

const databases: PosDatabase[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); vi.unstubAllGlobals(); delete process.env.YAHOO_SHOPPING_APP_ID; });

describe("Yahoo!ショッピングAPI商品検索", () => {
  it("JAN完全一致だけを参考価格候補として返す", async () => {
    process.env.YAHOO_SHOPPING_APP_ID = "test-app";
    const database = openDatabase(); databases.push(database);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hits: [
      { janCode: "4901234567890", name: "商品A", url: "https://store.example/a", price: 1280, brand: { name: "ブランドA" }, seller: { name: "販売店A" } },
      { janCode: "4901234567899", name: "別商品", url: "https://store.example/b", price: 999 },
    ] }) });
    vi.stubGlobal("fetch", fetchMock);
    const candidates = await fetchYahooShoppingCandidates(database, "4901234567890");
    expect(candidates).toEqual([expect.objectContaining({ name: "商品A", brand: "ブランドA", seller: "販売店A", price: 1280, priceType: "reference", source: "Yahoo!ショッピングAPI" })]);
    const request = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(request.searchParams.get("jan_code")).toBe("4901234567890");
    expect(request.searchParams.get("condition")).toBe("new");
    expect(request.searchParams.get("in_stock")).toBe("true");
    expect(request.searchParams.get("results")).toBe("50");
  });
});
