import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type PosDatabase } from "./db.js";
import { applyProductLookupFeedback, lookupProductCandidates, recordProductLookupFeedback } from "./product-lookup.js";

const databases: PosDatabase[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

const cachedResult = {
  code: "4901234567890",
  codeKind: "ean-13",
  existingProducts: [],
  candidates: [{ name: "PILOT ハンズ インキ", source: "test", strength: "weak" as const, reason: "test" }],
  searchedAt: "2026-08-05T00:00:00.000Z",
};

describe("商品検索feedback", () => {
  it("negativeをキャッシュ返却にも適用し、positiveで候補名を戻す", async () => {
    const database = openDatabase(); databases.push(database);
    database.prepare("INSERT INTO product_lookup_cache(cache_key,event_id,code,result_json,fetched_at,expires_at) VALUES (?,?,?,?,?,?)").run("event-1:4901234567890", "event-1", "4901234567890", JSON.stringify(cachedResult), cachedResult.searchedAt, "2099-01-01T00:00:00.000Z");
    recordProductLookupFeedback(database, "event-1", "4901234567890", "ハンズ", "negative", "actor-1");
    const excluded = await lookupProductCandidates(database, "event-1", undefined, "4901234567890");
    expect(excluded).toMatchObject({ excludedTokens: ["ハンズ"], candidates: [{ name: "PILOT インキ" }] });
    recordProductLookupFeedback(database, "event-1", "4901234567890", "ハンズ", "positive", "actor-1");
    expect(applyProductLookupFeedback(database, "event-1", "4901234567890", cachedResult)).toMatchObject({ excludedTokens: [], candidates: cachedResult.candidates });
  });
});
