import { importEventCatalog, lookupGs1Company, parseBarcode, type ProductLookupCandidate, type ProductLookupResult } from "@event-pos/contracts";
import { fetchNdlIsbnProduct } from "./isbn.js";
import { fetchIsdnProduct } from "./isdn.js";
import { loadGs1CompanyPrefixRegistry } from "./gs1-registry.js";
import type { PosDatabase } from "./db.js";
import { getCatalog } from "./db.js";

const normalize = (code: string) => code.replace(/[\s-]/g, "");
async function braveCandidates(code: string): Promise<ProductLookupCandidate[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search"); url.searchParams.set("q", `"${code}" 商品`); url.searchParams.set("count", "5");
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), headers: { Accept: "application/json", "X-Subscription-Token": key } });
  if (!response.ok) return [];
  const data = await response.json() as { web?: { results?: Array<{ title?: string; description?: string; url?: string }> } };
  return (data.web?.results ?? []).flatMap((result) => result.title && result.url ? [{ name: result.title, url: result.url, source: "Brave Search", strength: "weak" as const, reason: result.description ?? "JANコード完全一致検索の検索結果" }] : []);
}

export async function lookupProductCandidates(database: PosDatabase, eventId: string, configDirectory: string | undefined, codeInput: string): Promise<ProductLookupResult> {
  const code = normalize(codeInput);
  if (!/^\d{8,18}$/.test(code)) throw new Error("商品コードは数字8〜18桁で入力してください");
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
    candidates.push({ name: info.productName, ...(info.author ? { author: info.author } : {}), ...(info.publisherName ? { company: info.publisherName } : {}), ...(info.price === undefined ? {} : { price: info.price }), url: info.sourceUrl, source: "NDLサーチ", strength: "strong", reason: "ISBN完全一致の書誌情報" });
  } else if (code.startsWith("278") && code.length === 13) {
    const info = await fetchIsdnProduct(code);
    candidates.push({ name: info.productName, ...(info.author ? { author: info.author } : {}), ...(info.publisherName ? { company: info.publisherName } : {}), ...(info.price === undefined ? {} : { price: info.price }), url: info.sourceUrl, source: "ISDN", strength: "strong", reason: "ISDN完全一致の公開情報" });
  }
  if (candidates.length === 0 || candidates.every((candidate) => candidate.strength !== "strong")) candidates.push(...await braveCandidates(code));
  return { code, codeKind: parsed.kind, existingProducts, candidates, searchedAt: new Date().toISOString() };
}
