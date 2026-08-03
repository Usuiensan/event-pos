import type { IsbnProductInfo } from "@event-pos/contracts";

const NDL_ORIGIN = "https://ndlsearch.ndl.go.jp/api/opensearch";
const entity = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string): string | undefined => { const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return match?.[1] === undefined ? undefined : entity(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()); };

export function parseNdlIsbnXml(xml: string, code: string, fetchedAt = new Date().toISOString()): IsbnProductInfo {
  const item = xml.match(/<item(?:\s|>)([\s\S]*?)<\/item>/);
  if (!item) throw new Error("NDLサーチにISBNの書誌情報がありません");
  const body = item[0];
  const productName = tag(body, "dc:title") ?? tag(body, "title");
  if (!productName) throw new Error("NDLサーチにISBNの商品名がありません");
  const author = tag(body, "dc:creator");
  const publisherName = tag(body, "dc:publisher");
  const issued = tag(body, "dcterms:issued") ?? tag(body, "dc:date");
  const priceText = tag(body, "dcndl:price") ?? tag(body, "price");
  const priceMatch = priceText?.replace(/,/g, "").match(/(\d+)/);
  const price = priceMatch ? Number(priceMatch[1]) : undefined;
  return {
    code,
    productName,
    ...(author === undefined ? {} : { author }),
    ...(publisherName === undefined ? {} : { publisherName }),
    ...(issued === undefined ? {} : { issued }),
    ...(price === undefined ? {} : { price }),
    sourceUrl: `${NDL_ORIGIN}?isbn=${code}&cnt=1`,
    fetchedAt,
  };
}

export async function fetchNdlIsbnProduct(code: string): Promise<IsbnProductInfo> {
  if (!/^97[89]\d{10}$/.test(code)) throw new Error("ISBNは978または979で始まる13桁の番号です");
  const response = await fetch(`${NDL_ORIGIN}?isbn=${encodeURIComponent(code)}&cnt=1`, { signal: AbortSignal.timeout(8_000), headers: { accept: "application/rss+xml, application/xml" } });
  if (!response.ok) throw new Error(`NDLサーチからISBN情報を取得できません（HTTP ${response.status}）`);
  return parseNdlIsbnXml(await response.text(), code);
}
