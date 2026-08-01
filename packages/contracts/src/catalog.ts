export type ProductDefinition = {
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: number;
  saleState: "on_sale" | "off_sale";
  internalToken?: string;
};

export type QuickEntry = {
  id: string;
  label: string;
  productCode?: string;
  quantity?: number;
  components?: Array<{ productCode: string; quantity: number }>;
};

export type EventCatalog = { eventId: string; products: ProductDefinition[]; quickEntries: QuickEntry[] };

function fail(message: string): never { throw new Error(message); }

export function validateEventCatalog(input: unknown): EventCatalog {
  if (!input || typeof input !== "object") fail("カタログはJSONオブジェクトで指定してください");
  const value = input as Partial<EventCatalog>;
  if (typeof value.eventId !== "string" || !value.eventId.trim()) fail("eventIdが必要です");
  if (!Array.isArray(value.products) || !Array.isArray(value.quickEntries)) fail("productsとquickEntriesが必要です");
  const products = value.products.map((raw, index) => {
    const p = raw as Partial<ProductDefinition>;
    if (typeof p.productCode !== "string" || !p.productCode.trim()) fail(`products[${index}].productCodeが必要です`);
    if (typeof p.name !== "string" || !p.name.trim()) fail(`products[${index}].nameが必要です`);
    if (typeof p.priceInclTax !== "number" || !Number.isSafeInteger(p.priceInclTax) || p.priceInclTax < 0) fail(`products[${index}].priceInclTaxは0以上の整数です`);
    if (typeof p.taxRate !== "number" || p.taxRate < 0 || p.taxRate > 100) fail(`products[${index}].taxRateが不正です`);
    if (p.saleState !== "on_sale" && p.saleState !== "off_sale") fail(`products[${index}].saleStateが不正です`);
    const priceInclTax = p.priceInclTax as number;
    return { productCode: p.productCode, name: p.name, priceInclTax, taxRate: p.taxRate, saleState: p.saleState, ...(typeof p.internalToken === "string" ? { internalToken: p.internalToken } : {}) };
  });
  const codes = new Set<string>();
  for (const p of products) if (codes.has(p.productCode)) fail(`商品コードが重複しています: ${p.productCode}`); else codes.add(p.productCode);
  const quickEntries = value.quickEntries.map((raw, index) => {
    const q = raw as Partial<QuickEntry>;
    if (typeof q.id !== "string" || !q.id.trim() || typeof q.label !== "string" || !q.label.trim()) fail(`quickEntries[${index}]のid/labelが必要です`);
    if (q.productCode !== undefined && (typeof q.productCode !== "string" || !codes.has(q.productCode))) fail(`quickEntries[${index}].productCodeが存在しません`);
    if (q.quantity !== undefined && (!Number.isSafeInteger(q.quantity) || q.quantity <= 0)) fail(`quickEntries[${index}].quantityが不正です`);
    if (q.components !== undefined) {
      if (!Array.isArray(q.components) || q.components.length === 0) fail(`quickEntries[${index}].componentsが不正です`);
      for (const c of q.components) if (!codes.has(c.productCode) || !Number.isSafeInteger(c.quantity) || c.quantity <= 0) fail(`quickEntries[${index}].componentsが不正です`);
    }
    if (q.productCode === undefined && q.components === undefined) fail(`quickEntries[${index}]に商品またはcomponentsが必要です`);
    const result: QuickEntry = { id: q.id, label: q.label };
    if (q.productCode) result.productCode = q.productCode;
    if (q.quantity) result.quantity = q.quantity;
    if (q.components) result.components = q.components;
    return result;
  });
  return { eventId: value.eventId, products, quickEntries };
}

export function importEventCatalog(json: string): EventCatalog { try { return validateEventCatalog(JSON.parse(json)); } catch (error) { throw new Error(error instanceof Error ? error.message : "JSONが不正です"); } }
export function exportEventCatalog(catalog: EventCatalog): string { return `${JSON.stringify(validateEventCatalog(catalog), null, 2)}\n`; }
