export type ProductDefinition = {
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: number;
  saleState: "on_sale" | "off_sale";
  internalToken?: string;
  ageCheck?: "none" | "18" | "20";
  tabId?: string;
  displayColor?: string;
  thumbnailUrl?: string;
};

export type ProductTab = { id: string; label: string; color?: string };
export type StaffPermission = "catalog_import" | "refund" | "reprint";
export type StaffMember = { responsibleNumber: string; displayName: string; permissions?: StaffPermission[] };

export type QuickEntry = {
  id: string;
  label: string;
  productCode?: string;
  quantity?: number;
  components?: Array<{ productCode: string; quantity: number }>;
  tabId?: string;
};

export type EventCatalog = { eventId: string; products: ProductDefinition[]; quickEntries: QuickEntry[]; staffMembers?: StaffMember[]; productTabs?: ProductTab[]; autoDiscountRules?: AutoDiscountRule[] };

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
    if (p.ageCheck !== undefined && p.ageCheck !== "none" && p.ageCheck !== "18" && p.ageCheck !== "20") fail(`products[${index}].ageCheckが不正です`);
    for (const key of ["displayColor", "tabId", "thumbnailUrl"] as const) if (p[key] !== undefined && typeof p[key] !== "string") fail(`products[${index}].${key}が不正です`);
    return { productCode: p.productCode, name: p.name, priceInclTax, taxRate: p.taxRate, saleState: p.saleState, ...(typeof p.internalToken === "string" ? { internalToken: p.internalToken } : {}), ...(p.ageCheck ? { ageCheck: p.ageCheck } : {}), ...(p.tabId ? { tabId: p.tabId } : {}), ...(p.displayColor ? { displayColor: p.displayColor } : {}), ...(p.thumbnailUrl ? { thumbnailUrl: p.thumbnailUrl } : {}) };
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
    if (q.tabId !== undefined) { if (typeof q.tabId !== "string" || !q.tabId.trim()) fail(`quickEntries[${index}].tabIdが不正です`); result.tabId = q.tabId; }
    return result;
  });
  const autoDiscountRules = value.autoDiscountRules?.map((raw, index) => {
    const rule = raw as Partial<AutoDiscountRule>;
    if (typeof rule.id !== "string" || !rule.id.trim() || typeof rule.label !== "string" || !rule.label.trim()) fail(`autoDiscountRules[${index}].id/labelが必要です`);
    if (!Array.isArray(rule.requiredProducts) || rule.requiredProducts.length === 0) fail(`autoDiscountRules[${index}].requiredProductsが必要です`);
    if (typeof rule.discountYen !== "number" || !Number.isSafeInteger(rule.discountYen) || rule.discountYen <= 0) fail(`autoDiscountRules[${index}].discountYenが不正です`);
    if (rule.priority !== undefined && !Number.isSafeInteger(rule.priority)) fail(`autoDiscountRules[${index}].priorityが不正です`);
    const seen = new Set<string>();
    const requiredProducts = rule.requiredProducts.map((item, componentIndex) => { if (!codes.has(item.productCode) || !Number.isSafeInteger(item.quantity) || item.quantity <= 0 || seen.has(item.productCode)) fail(`autoDiscountRules[${index}].requiredProducts[${componentIndex}]が不正です`); seen.add(item.productCode); return { productCode: item.productCode, quantity: item.quantity }; });
    const discountYen = rule.discountYen as number;
    const maximumDiscount = requiredProducts.reduce((sum, item) => sum + products.find((product) => product.productCode === item.productCode)!.priceInclTax * item.quantity, 0);
    if (discountYen > maximumDiscount) fail(`autoDiscountRules[${index}].discountYenが対象商品の合計を超えています`);
    return { id: rule.id, label: rule.label, requiredProducts, discountYen, ...(rule.priority !== undefined ? { priority: rule.priority } : {}) };
  });
  if (autoDiscountRules) { const ids = new Set<string>(); for (const rule of autoDiscountRules) if (ids.has(rule.id)) fail(`autoDiscountRules.idが重複しています: ${rule.id}`); else ids.add(rule.id); }
  const productTabs = value.productTabs?.map((raw, index) => { const tab = raw as Partial<ProductTab>; if (typeof tab.id !== "string" || !tab.id.trim() || typeof tab.label !== "string" || !tab.label.trim()) fail(`productTabs[${index}]のid/labelが必要です`); if (tab.color !== undefined && typeof tab.color !== "string") fail(`productTabs[${index}].colorが不正です`); return { id: tab.id, label: tab.label, ...(tab.color ? { color: tab.color } : {}) }; });
  const staffMembers = value.staffMembers?.map((raw, index) => { const member = raw as Partial<StaffMember>; if (typeof member.responsibleNumber !== "string" || !/^\d{3}$/.test(member.responsibleNumber)) fail(`staffMembers[${index}].responsibleNumberは3桁の数字です`); if (typeof member.displayName !== "string" || !member.displayName.trim()) fail(`staffMembers[${index}].displayNameが必要です`); const allowedPermissions: StaffPermission[] = ["catalog_import", "refund", "reprint"]; if (member.permissions !== undefined && (!Array.isArray(member.permissions) || member.permissions.some((permission) => !allowedPermissions.includes(permission)))) fail(`staffMembers[${index}].permissionsが不正です`); return { responsibleNumber: member.responsibleNumber, displayName: member.displayName.trim(), ...(member.permissions ? { permissions: [...new Set(member.permissions)] } : {}) }; });
  if (staffMembers) { const numbers = new Set<string>(); for (const member of staffMembers) if (numbers.has(member.responsibleNumber)) fail(`責任者番号が重複しています: ${member.responsibleNumber}`); else numbers.add(member.responsibleNumber); }
  return { eventId: value.eventId, products, quickEntries, ...(staffMembers ? { staffMembers } : {}), ...(productTabs ? { productTabs } : {}), ...(autoDiscountRules ? { autoDiscountRules } : {}) };
}

export function importEventCatalog(json: string): EventCatalog { try { return validateEventCatalog(JSON.parse(json)); } catch (error) { throw new Error(error instanceof Error ? error.message : "JSONが不正です"); } }
export function exportEventCatalog(catalog: EventCatalog): string { return `${JSON.stringify(validateEventCatalog(catalog), null, 2)}\n`; }
import type { AutoDiscountRule } from "./auto-discount.js";
