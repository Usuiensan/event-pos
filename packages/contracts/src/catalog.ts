import type { Gs1ProductCodeInfo } from "./gs1-company-prefix.js";
import type { IsdnProductInfo } from "./isdn.js";

export type ProductDefinition = {
  productCode: string;
  name: string;
  manufacturer?: string;
  brand?: string;
  seller?: string;
  producer?: string;
  specification?: string;
  departmentId?: string;
  priceInclTax: number;
  taxRate: number;
  taxCategory: TaxCategory;
  priceExclTax?: number;
  saleState: "on_sale" | "off_sale";
  internalToken?: string;
  ageCheck?: "none" | "18" | "20";
  tabId?: string;
  displayColor?: string;
  thumbnailUrl?: string;
  gs1?: Gs1ProductCodeInfo;
  isdn?: IsdnProductInfo;
  inventory?: { openingQuantity: number | null };
};

export const taxCategories = ["inclusive_10", "inclusive_8", "exclusive_10", "exclusive_8", "exempt", "non_taxable"] as const;
export type TaxCategory = typeof taxCategories[number];

const taxCategoryLabels: Record<TaxCategory, string> = {
  inclusive_10: "税込10%",
  inclusive_8: "税込8%",
  exclusive_10: "税抜10%",
  exclusive_8: "税抜8%",
  exempt: "非課税",
  non_taxable: "不課税",
};

export function taxCategoryLabel(category: TaxCategory): string { return taxCategoryLabels[category]; }
export function taxRateForCategory(category: TaxCategory): number {
  if (category === "inclusive_10" || category === "exclusive_10") return 10;
  if (category === "inclusive_8" || category === "exclusive_8") return 8;
  return 0;
}

function legacyTaxCategory(taxRate: number): TaxCategory {
  if (taxRate === 10) return "inclusive_10";
  if (taxRate === 8) return "inclusive_8";
  if (taxRate === 0) return "exempt";
  fail("税区分は税込10%・税込8%・税抜10%・税抜8%・非課税・不課税から指定してください");
}

export type ProductTab = { id: string; label: string; color?: string };
export type StaffPermission = "catalog_import" | "refund" | "void" | "reprint" | "cash_check" | "business_close";
export type StaffRole = "operator" | "manager" | "admin";
export type StaffMember = { staffId?: string; responsibleNumber: string; displayName: string; receiptDisplay?: "number" | "name"; role?: StaffRole; permissions?: StaffPermission[] };
export type CustomerWelcome = { message?: string; circleName?: string; space?: string; imageUrl?: string };
export type EventDetails = { name: string; businessDate: string; seller: { circleName: string; space: string; receiptIssuerName: string }; locale: { language: string; currency: string; timezone: string } };
export type Department = { departmentId: string; code: string; name: string; settlementOwnerId: string; enabled: boolean };
export type ReceiptSettings = { templates: Record<string, { templateKey: string; activeVersion: number; templatePath?: string }>; commonText?: { footer?: string; returnPolicy?: string } };

export type QuickEntry = {
  id: string;
  label: string;
  productCode?: string;
  quantity?: number;
  components?: Array<{ productCode: string; quantity: number }>;
  tabId?: string;
};

export type EventCatalog = { eventId: string; event?: EventDetails; products: ProductDefinition[]; quickEntries: QuickEntry[]; staffMembers?: StaffMember[]; productTabs?: ProductTab[]; autoDiscountRules?: AutoDiscountRule[]; customerWelcome?: CustomerWelcome; departments?: Department[]; receiptSettings?: ReceiptSettings };

function fail(message: string): never { throw new Error(message); }

function validGs1Prefix(prefix: number): boolean { return (prefix >= 0 && prefix <= 49) || (prefix >= 60 && prefix <= 139) || (prefix >= 200 && prefix <= 969) || (prefix >= 977 && prefix <= 999); }
function validGtinCheckDigit(code: string): boolean { let sum = 0; let weight = 3; for (let index = code.length - 2; index >= 0; index -= 1) { sum += Number(code[index]) * weight; weight = weight === 3 ? 1 : 3; } return (10 - (sum % 10)) % 10 === Number(code.at(-1)); }
function validateExternalProductCode(code: string, index: number): void {
  if (!/^\d+$/.test(code)) return;
  const gtin = code.length === 18 ? code.slice(0, 13) : code;
  if (![8, 12, 13, 14].includes(gtin.length)) return;
  // 既存のゼロ始まり短縮商品コードは内部コードとして維持する。
  if ((gtin.length === 8 || gtin.length === 14) && gtin.startsWith("0")) return;
  if (!validGtinCheckDigit(gtin)) fail(`products[${index}].productCodeのチェックデジットが不正です（GTIN-${gtin.length}${code.length === 18 ? "本体部" : ""}）`);
  if (code.length === 18 && !/^491\d{15}$/.test(code)) fail(`products[${index}].productCodeの18桁コードは定期刊行物JANコードです`);
  if (gtin.length === 8 || gtin.length === 14) return;
  const prefix = Number(gtin.slice(0, 3));
  if (!validGs1Prefix(prefix)) fail(`products[${index}].productCodeのGS1プレフィックス（国・地域番号）が不正です: ${gtin.slice(0, 3)}`);
  const companyCode = gtin.length === 13 ? gtin.slice(3, -1) : gtin.slice(2, -1);
  if (!/[1-9]/.test(companyCode)) fail(`products[${index}].productCodeの事業者コードが不正です`);
}

export function validateEventCatalog(input: unknown): EventCatalog {
  if (!input || typeof input !== "object") fail("カタログはJSONオブジェクトで指定してください");
  const value = input as Partial<EventCatalog>;
  if (typeof value.eventId !== "string" || !value.eventId.trim()) fail("eventIdが必要です");
  if (!Array.isArray(value.products) || !Array.isArray(value.quickEntries)) fail("productsとquickEntriesが必要です");
  const products = value.products.map((raw, index) => {
    const p = raw as Partial<ProductDefinition>;
    if (typeof p.productCode !== "string" || !p.productCode.trim()) fail(`products[${index}].productCodeが必要です`);
    validateExternalProductCode(p.productCode, index);
    if (typeof p.name !== "string" || !p.name.trim()) fail(`products[${index}].nameが必要です`);
    if (typeof p.priceInclTax !== "number" || !Number.isSafeInteger(p.priceInclTax) || p.priceInclTax < 0) fail(`products[${index}].priceInclTaxは0以上の整数です`);
    if (typeof p.taxRate !== "number" || p.taxRate < 0 || p.taxRate > 100) fail(`products[${index}].taxRateが不正です`);
    const taxCategory = p.taxCategory === undefined ? legacyTaxCategory(p.taxRate) : p.taxCategory;
    if (!taxCategories.includes(taxCategory)) fail(`products[${index}].taxCategoryが不正です`);
    if (p.taxRate !== taxRateForCategory(taxCategory)) fail(`products[${index}].taxRateが税区分と一致しません`);
    const exclusive = taxCategory === "exclusive_10" || taxCategory === "exclusive_8";
    if (exclusive) {
      if (!Number.isSafeInteger(p.priceExclTax) || (p.priceExclTax ?? -1) < 0) fail(`products[${index}].priceExclTaxは税抜区分で必要な0以上の整数です`);
      const expected = p.priceExclTax! + Math.floor(p.priceExclTax! * p.taxRate / 100);
      if (p.priceInclTax !== expected) fail(`products[${index}].priceInclTaxは税抜価格から計算した${expected}円と一致させてください`);
    } else if (p.priceExclTax !== undefined) fail(`products[${index}].priceExclTaxは税抜区分だけで指定できます`);
    if (p.saleState !== "on_sale" && p.saleState !== "off_sale") fail(`products[${index}].saleStateが不正です`);
    const priceInclTax = p.priceInclTax as number;
    if (p.ageCheck !== undefined && p.ageCheck !== "none" && p.ageCheck !== "18" && p.ageCheck !== "20") fail(`products[${index}].ageCheckが不正です`);
    for (const key of ["departmentId", "manufacturer", "brand", "seller", "producer", "specification", "displayColor", "tabId", "thumbnailUrl"] as const) if (p[key] !== undefined && typeof p[key] !== "string") fail(`products[${index}].${key}が不正です`);
    if (p.gs1 !== undefined && (!p.gs1 || typeof p.gs1 !== "object" || (p.gs1.codeType !== "upc-a" && p.gs1.codeType !== "ean-13"))) fail(`products[${index}].gs1が不正です`);
    if (p.isdn !== undefined && (!p.isdn || typeof p.isdn !== "object" || typeof p.isdn.code !== "string" || typeof p.isdn.productName !== "string" || typeof p.isdn.sourceUrl !== "string" || typeof p.isdn.fetchedAt !== "string")) fail(`products[${index}].isdnが不正です`);
    if (p.inventory !== undefined && (!p.inventory || typeof p.inventory !== "object" || !Object.prototype.hasOwnProperty.call(p.inventory, "openingQuantity") || (p.inventory.openingQuantity !== null && (!Number.isSafeInteger(p.inventory.openingQuantity) || p.inventory.openingQuantity < 0)))) fail(`products[${index}].inventory.openingQuantityが不正です`);
    return { productCode: p.productCode, name: p.name, ...(p.departmentId ? { departmentId: p.departmentId } : {}), ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}), ...(p.brand ? { brand: p.brand } : {}), ...(p.seller ? { seller: p.seller } : {}), ...(p.producer ? { producer: p.producer } : {}), ...(p.specification ? { specification: p.specification } : {}), priceInclTax, taxRate: p.taxRate, taxCategory, ...(p.priceExclTax !== undefined ? { priceExclTax: p.priceExclTax } : {}), saleState: p.saleState, ...(typeof p.internalToken === "string" ? { internalToken: p.internalToken } : {}), ...(p.ageCheck ? { ageCheck: p.ageCheck } : {}), ...(p.tabId ? { tabId: p.tabId } : {}), ...(p.displayColor ? { displayColor: p.displayColor } : {}), ...(p.thumbnailUrl ? { thumbnailUrl: p.thumbnailUrl } : {}), ...(p.gs1 ? { gs1: p.gs1 } : {}), ...(p.isdn ? { isdn: p.isdn } : {}), ...(p.inventory !== undefined ? { inventory: { openingQuantity: p.inventory.openingQuantity! } } : {}) };
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
  const staffMembers = value.staffMembers?.map((raw, index) => { const member = raw as Partial<StaffMember>; if (typeof member.responsibleNumber !== "string" || !/^\d{3}$/.test(member.responsibleNumber)) fail(`staffMembers[${index}].responsibleNumberは3桁の数字です`); if (typeof member.displayName !== "string" || !member.displayName.trim()) fail(`staffMembers[${index}].displayNameが必要です`); if (member.staffId !== undefined && (typeof member.staffId !== "string" || !member.staffId.trim())) fail(`staffMembers[${index}].staffIdが不正です`); if (member.receiptDisplay !== undefined && member.receiptDisplay !== "number" && member.receiptDisplay !== "name") fail(`staffMembers[${index}].receiptDisplayが不正です`); const allowedRoles: StaffRole[] = ["operator", "manager", "admin"]; if (member.role !== undefined && !allowedRoles.includes(member.role)) fail(`staffMembers[${index}].roleが不正です`); const allowedPermissions: StaffPermission[] = ["catalog_import", "refund", "void", "reprint", "cash_check", "business_close"]; if (member.permissions !== undefined && (!Array.isArray(member.permissions) || member.permissions.some((permission) => !allowedPermissions.includes(permission)))) fail(`staffMembers[${index}].permissionsが不正です`); return { ...(member.staffId ? { staffId: member.staffId } : {}), responsibleNumber: member.responsibleNumber, displayName: member.displayName.trim(), ...(member.receiptDisplay ? { receiptDisplay: member.receiptDisplay } : {}), ...(member.role ? { role: member.role } : {}), ...(member.permissions ? { permissions: [...new Set(member.permissions)] } : {}) }; });
  if (staffMembers) { const numbers = new Set<string>(); for (const member of staffMembers) if (numbers.has(member.responsibleNumber)) fail(`責任者番号が重複しています: ${member.responsibleNumber}`); else numbers.add(member.responsibleNumber); }
  let customerWelcome: CustomerWelcome | undefined;
  if (value.customerWelcome !== undefined) {
    if (!value.customerWelcome || typeof value.customerWelcome !== "object" || Array.isArray(value.customerWelcome)) fail("customerWelcomeはJSONオブジェクトで指定してください");
    customerWelcome = {};
    for (const key of ["message", "circleName", "space", "imageUrl"] as const) {
      const field = value.customerWelcome[key];
      if (field !== undefined && typeof field !== "string") fail(`customerWelcome.${key}は文字列で指定してください`);
      if (typeof field === "string" && field.trim()) customerWelcome[key] = field.trim();
    }
  }
  const departments = value.departments?.map((raw, index) => { const d = raw as Partial<Department>; if (typeof d.departmentId !== "string" || !d.departmentId.trim() || typeof d.code !== "string" || !d.code.trim() || typeof d.name !== "string" || !d.name.trim() || typeof d.settlementOwnerId !== "string" || !d.settlementOwnerId.trim() || typeof d.enabled !== "boolean") fail(`departments[${index}]が不正です`); return { departmentId: d.departmentId, code: d.code, name: d.name, settlementOwnerId: d.settlementOwnerId, enabled: d.enabled }; });
  if (departments) { const ids = new Set<string>(); const codes = new Set<string>(); for (const d of departments) { if (ids.has(d.departmentId) || codes.has(d.code)) fail(`departmentIdまたはcodeが重複しています: ${d.departmentId}`); ids.add(d.departmentId); codes.add(d.code); } }
  let receiptSettings: ReceiptSettings | undefined;
  if (value.receiptSettings !== undefined) { const r = value.receiptSettings as Partial<ReceiptSettings>; if (!r || typeof r !== "object" || Array.isArray(r) || !r.templates || typeof r.templates !== "object" || Array.isArray(r.templates)) fail("receiptSettings.templatesが必要です"); const templates: ReceiptSettings["templates"] = {}; for (const [kind, raw] of Object.entries(r.templates)) { const t = raw as Partial<ReceiptSettings["templates"][string]>; const activeVersion = t.activeVersion; if (!kind.trim() || typeof t.templateKey !== "string" || !t.templateKey.trim() || !Number.isSafeInteger(activeVersion) || (activeVersion as number) <= 0 || (t.templatePath !== undefined && typeof t.templatePath !== "string")) fail(`receiptSettings.templates.${kind}が不正です`); templates[kind] = { templateKey: t.templateKey, activeVersion: activeVersion as number, ...(t.templatePath ? { templatePath: t.templatePath } : {}) }; } receiptSettings = { templates, ...(r.commonText ? { commonText: r.commonText } : {}) }; }
  let event: EventDetails | undefined;
  if (value.event !== undefined) { const raw = value.event as Partial<EventDetails>; if (!raw || typeof raw.name !== "string" || !raw.name.trim() || typeof raw.businessDate !== "string" || !raw.businessDate.trim() || !raw.seller || typeof raw.seller.circleName !== "string" || typeof raw.seller.space !== "string" || typeof raw.seller.receiptIssuerName !== "string" || !raw.locale || typeof raw.locale.language !== "string" || typeof raw.locale.currency !== "string" || typeof raw.locale.timezone !== "string") fail("eventが不正です"); event = { name: raw.name, businessDate: raw.businessDate, seller: raw.seller, locale: raw.locale }; }
  return { eventId: value.eventId, ...(event ? { event } : {}), products, quickEntries, ...(staffMembers ? { staffMembers } : {}), ...(productTabs ? { productTabs } : {}), ...(autoDiscountRules ? { autoDiscountRules } : {}), ...(customerWelcome ? { customerWelcome } : {}), ...(departments ? { departments } : {}), ...(receiptSettings ? { receiptSettings } : {}) };
}

export function importEventCatalog(json: string): EventCatalog { try { return validateEventCatalog(JSON.parse(json)); } catch (error) { throw new Error(error instanceof Error ? error.message : "JSONが不正です"); } }
export function exportEventCatalog(catalog: EventCatalog): string { return `${JSON.stringify(validateEventCatalog(catalog), null, 2)}\n`; }
import type { AutoDiscountRule } from "./auto-discount.js";
