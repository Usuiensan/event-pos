import type { IsdnProductInfo } from "@event-pos/contracts";

const ISDN_ORIGIN = "https://isdn.jp/xml/";
const entity = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string): string | undefined => { const match = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return match?.[1] === undefined ? undefined : entity(match[1].trim()); };

export function parseIsdnXml(xml: string, code: string, fetchedAt = new Date().toISOString()): IsdnProductInfo {
  if (!/<item(?:\s|>)/.test(xml)) throw new Error("ISDNの商品情報が見つかりません");
  const productName = tag(xml, "product-name");
  if (!productName) throw new Error("ISDNの商品名がありません");
  const displayCode = tag(xml, "disp-isdn"); const productYomi = tag(xml, "product-yomi"); const publisherCode = tag(xml, "publisher-code"); const publisherName = tag(xml, "publisher-name"); const publisherYomi = tag(xml, "publisher-yomi"); const issueDate = tag(xml, "issue-date"); const genreName = tag(xml, "genre-name"); const ratingAge = tag(xml, "rating-age"); const author = tag(xml, "author"); const shape = tag(xml, "shape"); const contents = tag(xml, "contents"); const priceUnit = tag(xml, "price-unit"); const barcode2 = tag(xml, "barcode2"); const sampleImageUri = tag(xml, "sample-image-uri");
  const priceText = tag(xml, "price");
  const price = priceText && /^\d+$/.test(priceText) ? Number(priceText) : undefined;
  return {
    code,
    ...(displayCode === undefined ? {} : { displayCode }),
    productName,
    ...(productYomi === undefined ? {} : { productYomi }), ...(publisherCode === undefined ? {} : { publisherCode }), ...(publisherName === undefined ? {} : { publisherName }), ...(publisherYomi === undefined ? {} : { publisherYomi }), ...(issueDate === undefined ? {} : { issueDate }), ...(genreName === undefined ? {} : { genreName }), ...(ratingAge === undefined ? {} : { ratingAge }), ...(author === undefined ? {} : { author }), ...(shape === undefined ? {} : { shape }), ...(contents === undefined ? {} : { contents }),
    ...(price === undefined ? {} : { price }),
    ...(priceUnit === undefined ? {} : { priceUnit }), ...(barcode2 === undefined ? {} : { barcode2 }), ...(sampleImageUri === undefined ? {} : { sampleImageUri }),
    sourceUrl: `${ISDN_ORIGIN}${code}`,
    fetchedAt,
  };
}

export async function fetchIsdnProduct(code: string): Promise<IsdnProductInfo> {
  if (!/^\d{13}$/.test(code) || !code.startsWith("278")) throw new Error("ISDNは278で始まる13桁の番号です");
  const response = await fetch(`${ISDN_ORIGIN}${code}`, { signal: AbortSignal.timeout(8_000), headers: { accept: "text/xml" } });
  if (!response.ok) throw new Error(`ISDN情報を取得できません（HTTP ${response.status}）`);
  return parseIsdnXml(await response.text(), code);
}
