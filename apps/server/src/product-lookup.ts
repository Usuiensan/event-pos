import { importEventCatalog, lookupGs1Company, parseBarcode, type ProductLookupCandidate, type ProductLookupResult } from "@event-pos/contracts";
import { fetchNdlIsbnProduct } from "./isbn.js";
import { fetchIsdnProduct } from "./isdn.js";
import { loadGs1CompanyPrefixRegistry } from "./gs1-registry.js";
import type { PosDatabase } from "./db.js";
import { getCatalog } from "./db.js";
import { randomUUID } from "node:crypto";
import { fetchYahooShoppingCandidates } from "./yahoo-shopping.js";

const normalize = (code: string) => code.replace(/[\s-]/g, "");
const normalizeLookupToken = (value: string) => value.normalize("NFKC").trim().toLocaleLowerCase("ja-JP");
const integerEnv = (name: string, fallback: number) => { const value = Number.parseInt(process.env[name] ?? "", 10); return Number.isSafeInteger(value) && value > 0 ? value : fallback; };
const braveLimitConfig = () => ({ monthly: integerEnv("BRAVE_SEARCH_MONTHLY_LIMIT", 900), daily: integerEnv("BRAVE_SEARCH_DAILY_LIMIT", 100), perMinute: integerEnv("BRAVE_SEARCH_PER_MINUTE_LIMIT", 10), minIntervalMs: integerEnv("BRAVE_SEARCH_MIN_INTERVAL_MS", 1000), alertAt: integerEnv("BRAVE_SEARCH_ALERT_AT", 800) });
function reserveBraveSearch(database: PosDatabase, code: string): void {
  const now = new Date(); const iso = now.toISOString(); const config = braveLimitConfig();
  const monthly = Number((database.prepare("SELECT COUNT(*) AS count FROM brave_search_usage WHERE requested_at>=strftime('%Y-%m-01T00:00:00.000Z','now')").get() as { count: number }).count);
  const daily = Number((database.prepare("SELECT COUNT(*) AS count FROM brave_search_usage WHERE requested_at>=datetime('now','start of day')").get() as { count: number }).count);
  const minute = Number((database.prepare("SELECT COUNT(*) AS count FROM brave_search_usage WHERE requested_at>=datetime('now','-1 minute')").get() as { count: number }).count);
  const latest = database.prepare("SELECT requested_at FROM brave_search_usage ORDER BY requested_at DESC LIMIT 1").get() as { requested_at?: string } | undefined;
  if (monthly >= config.monthly) throw new Error(`Brave Search APIの月間上限(${config.monthly}件)に達したため検索を停止しました`);
  if (daily >= config.daily) throw new Error(`Brave Search APIの日次上限(${config.daily}件)に達したため検索を停止しました`);
  if (minute >= config.perMinute) throw new Error(`Brave Search APIの分間上限(${config.perMinute}件)に達したため検索を停止しました`);
  if (latest && now.getTime() - Date.parse(latest.requested_at ?? "") < config.minIntervalMs) throw new Error("Brave Search APIの連続検索を抑制中です。少し待ってから再試行してください");
  database.prepare("INSERT INTO brave_search_usage(request_id,requested_at,code,outcome) VALUES (?,?,?,'reserved')").run(randomUUID(), iso, code);
  if (monthly + 1 >= config.alertAt) console.warn(`[brave-search] 月間利用 ${monthly + 1}/${config.monthly} 件。無料枠超過防止のため上限まで残り ${config.monthly - monthly - 1} 件`);
}
async function braveCandidates(database: PosDatabase, code: string): Promise<ProductLookupCandidate[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  reserveBraveSearch(database, code);
  const url = new URL("https://api.search.brave.com/res/v1/web/search"); url.searchParams.set("q", `"${code}" 商品 -site:jancode.xyz`); url.searchParams.set("count", "5");
  // 呼び出し回数はDBへ予約記録し、再起動後も月次・日次・分間上限を維持する。
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json", "X-Subscription-Token": key } });
  if (!response.ok) return [];
  const data = await response.json() as { web?: { results?: Array<{ title?: string; description?: string; url?: string }> } };
  return (data.web?.results ?? []).flatMap((result) => {
    if (!result.title || !result.url) return [];
    try { if (new URL(result.url).hostname === "jancode.xyz" || new URL(result.url).hostname.endsWith(".jancode.xyz")) return []; } catch { return []; }
    return [{ name: result.title, url: result.url, source: "Brave Search", strength: "weak" as const, reason: result.description ?? "JANコード完全一致検索の検索結果" }];
  });
}

function feedbackState(database: PosDatabase, eventId: string, productCode: string): Map<string, "negative" | "positive"> {
  const state = new Map<string, "negative" | "positive">();
  const rows = database.prepare("SELECT token,feedback FROM product_lookup_feedback WHERE event_id=? AND product_code=? ORDER BY created_at,rowid").all(eventId, productCode) as Array<{ token: string; feedback: "negative" | "positive" }>;
  for (const row of rows) state.set(normalizeLookupToken(row.token), row.feedback);
  return state;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function removeFeedbackTokens(value: string, tokens: string[]): string {
  let result = value.normalize("NFKC");
  for (const token of tokens) result = result.replace(new RegExp(escapeRegExp(token), "giu"), " ");
  return result.replace(/\s+/g, " ").trim();
}

export function applyProductLookupFeedback(database: PosDatabase, eventId: string, productCode: string, result: ProductLookupResult): ProductLookupResult {
  const excludedTokens = [...feedbackState(database, eventId, productCode)].filter(([, feedback]) => feedback === "negative").map(([token]) => token).sort();
  if (excludedTokens.length === 0) return { ...result, excludedTokens: [] };
  const candidates = result.candidates.flatMap((candidate) => {
    if (!candidate.name) return [candidate];
    const name = removeFeedbackTokens(candidate.name, excludedTokens);
    if (!name && !candidate.company) return [];
    if (name) return [{ ...candidate, name }];
    const { name: _name, ...withoutName } = candidate;
    return [withoutName];
  });
  return { ...result, candidates, excludedTokens };
}

export async function lookupProductCandidates(database: PosDatabase, eventId: string, configDirectory: string | undefined, codeInput: string): Promise<ProductLookupResult> {
  const code = normalize(codeInput);
  if (!/^\d{8,18}$/.test(code)) throw new Error("商品コードは数字8〜18桁で入力してください");
  const cacheKey = `${eventId}:${code}`;
  const cached = database.prepare("SELECT result_json, expires_at FROM product_lookup_cache WHERE cache_key=?").get(cacheKey) as { result_json: string; expires_at: string } | undefined;
  if (cached && cached.expires_at > new Date().toISOString()) return applyProductLookupFeedback(database, eventId, code, JSON.parse(cached.result_json) as ProductLookupResult);
  const record = getCatalog(database, eventId);
  if (!record) throw new Error("商品カタログが見つかりません");
  const catalog = importEventCatalog(record.catalogJson);
  const parsed = parseBarcode(code);
  const existingProducts = catalog.products.filter((product) => product.productCode === code).map((product) => ({ productCode: product.productCode, name: product.name, priceInclTax: product.priceInclTax }));
  const candidates: ProductLookupCandidate[] = [];
  if (configDirectory) {
    const registry = await loadGs1CompanyPrefixRegistry(configDirectory).catch(() => undefined);
    const company = lookupGs1Company(registry, code);
    if (company) candidates.push({ company: company.companyName, source: "GS1事業者コード台帳", strength: "medium", reason: `GS1事業者コード ${company.prefix} の登録事業者` });
  }
  if (parsed.kind === "book-isbn") {
    const info = await fetchNdlIsbnProduct(code);
    candidates.push({ name: info.productName, ...(info.author ? { author: info.author } : {}), ...(info.publisherName ? { company: info.publisherName } : {}), ...(info.price === undefined ? {} : { price: info.price, priceType: "catalog" as const }), url: info.sourceUrl, source: "NDLサーチ", strength: "strong", reason: "ISBN完全一致の書誌情報" });
  } else if (code.startsWith("278") && code.length === 13) {
    const info = await fetchIsdnProduct(code);
    candidates.push({ name: info.productName, ...(info.author ? { author: info.author } : {}), ...(info.publisherName ? { company: info.publisherName } : {}), ...(info.price === undefined ? {} : { price: info.price, priceType: "catalog" as const }), url: info.sourceUrl, source: "ISDN", strength: "strong", reason: "ISDN完全一致の公開情報" });
  }
  const yahooCandidates = await fetchYahooShoppingCandidates(database, code).catch(() => []);
  candidates.push(...yahooCandidates);
  if (candidates.length === 0 || candidates.every((candidate) => candidate.strength !== "strong" && candidate.source !== "Yahoo!ショッピングAPI")) candidates.push(...await braveCandidates(database, code));
  const result = { code, codeKind: parsed.kind, existingProducts, candidates, searchedAt: new Date().toISOString() } satisfies ProductLookupResult;
  database.prepare("INSERT INTO product_lookup_cache(cache_key,event_id,code,result_json,fetched_at,expires_at) VALUES (?,?,?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json,fetched_at=excluded.fetched_at,expires_at=excluded.expires_at").run(cacheKey, eventId, code, JSON.stringify(result), result.searchedAt, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  return applyProductLookupFeedback(database, eventId, code, result);
}

export function recordProductLookupAdoption(database: PosDatabase, eventId: string, productCode: string, fieldName: string, candidate: ProductLookupCandidate, actorId: string): void {
  database.prepare("INSERT INTO product_lookup_adoptions(adoption_id,event_id,product_code,field_name,candidate_json,actor_id,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), eventId, productCode, fieldName, JSON.stringify(candidate), actorId, new Date().toISOString());
}

export function recordProductLookupFeedback(database: PosDatabase, eventId: string, productCode: string, token: string, feedback: "negative" | "positive", actorId: string): void {
  const normalizedToken = normalizeLookupToken(token);
  if (!normalizedToken) throw new Error("商品名要素の評価情報が不正です");
  database.prepare("INSERT INTO product_lookup_feedback(feedback_id,event_id,product_code,token,feedback,actor_id,created_at) VALUES (?,?,?,?,?,?,?)").run(randomUUID(), eventId, normalize(productCode), normalizedToken, feedback, actorId, new Date().toISOString());
}
