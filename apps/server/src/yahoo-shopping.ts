import type { ProductLookupCandidate } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import { randomUUID } from "node:crypto";

type YahooHit = {
  name?: string;
  description?: string;
  url?: string;
  janCode?: string;
  price?: number;
  brand?: { name?: string };
  seller?: { name?: string; url?: string };
};

type YahooResponse = { hits?: YahooHit[] };

function reserveYahooSearch(database: PosDatabase, code: string): void {
  const latest = database.prepare("SELECT requested_at FROM yahoo_search_usage ORDER BY requested_at DESC LIMIT 1").get() as { requested_at?: string } | undefined;
  if (latest?.requested_at && Date.now() - Date.parse(latest.requested_at) < 1000) throw new Error("Yahoo!ショッピングAPIの連続検索を抑制中です。少し待ってから再試行してください");
  database.prepare("INSERT INTO yahoo_search_usage(request_id,requested_at,code,outcome) VALUES (?,?,?,'reserved')").run(randomUUID(), new Date().toISOString(), code);
}

export async function fetchYahooShoppingCandidates(database: PosDatabase, code: string): Promise<ProductLookupCandidate[]> {
  const appId = process.env.YAHOO_SHOPPING_APP_ID;
  if (!appId) return [];
  reserveYahooSearch(database, code);
  const url = new URL("https://shopping.yahooapis.jp/ShoppingWebService/V3/itemSearch");
  url.searchParams.set("appid", appId);
  url.searchParams.set("jan_code", code);
  url.searchParams.set("condition", "new");
  url.searchParams.set("in_stock", "true");
  url.searchParams.set("results", "50");
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json" } });
  if (!response.ok) return [];
  const data = await response.json() as YahooResponse;
  return (data.hits ?? []).filter((hit): hit is YahooHit & { janCode: string; name: string; url: string } => hit.janCode === code && Boolean(hit.name) && Boolean(hit.url)).slice(0, 12).map((hit) => ({
    name: hit.name,
    ...(hit.brand?.name ? { brand: hit.brand.name } : {}),
    ...(hit.seller?.name ? { seller: hit.seller.name } : {}),
    ...(Number.isSafeInteger(hit.price) ? { price: hit.price, priceType: "reference" as const } : {}),
    url: hit.url,
    source: "Yahoo!ショッピングAPI",
    strength: "medium" as const,
    reason: "Yahoo!ショッピングAPIのJAN完全一致（新品・在庫あり）",
  }));
}
