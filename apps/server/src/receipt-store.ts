import { canonicalizeReceiptDocument } from "@event-pos/receipt-ir";
import { BUILTIN_FONT, DEFAULT_FINISHING_POLICY, ESCPOS_RENDERER_VERSION, bytesSha256, receiptDocumentToEscPos } from "@event-pos/escpos";
import { compileReceiptTemplate, DEFAULT_RECEIPT_TEMPLATE, DEFAULT_RECEIPT_TEMPLATE_VERSION, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V2, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V3, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V4, sha256Hex, validateReceiptTemplate, type ReceiptAssetDescriptor, type ReceiptSnapshot } from "@event-pos/receipt-template";
import type { PosDatabase } from "./db.js";

export type ReceiptTemplateRecord = {
  templateKey: string;
  version: number;
  sourceText: string;
  sourceSha256: string;
  status: "draft" | "active" | "retired";
  validatedSourceSha256?: string;
  validation?: unknown;
  createdAt: string;
  activatedAt?: string;
  assets: ReceiptAssetDescriptor[];
};

export type ReceiptArtifacts = {
  templateKey: string;
  templateVersion: number;
  templateSourceSha256: string;
  assets: ReceiptAssetDescriptor[];
  fontId: string;
  fontVersion: number;
  fontSha256: string;
  rendererVersion: string;
  finishingPolicyId: string;
  finishingPolicyVersion: number;
  snapshot: ReceiptSnapshot;
  canonicalIr: string;
  irSha256: string;
  escposBytes: Uint8Array;
  bytesSha256: string;
  humanReadable: string;
  warnings: string[];
};

function rowToTemplate(db: PosDatabase, row: Record<string, unknown>): ReceiptTemplateRecord {
  const templateKey = String(row.template_key); const version = Number(row.version);
  return {
    templateKey, version, sourceText: String(row.source_text), sourceSha256: String(row.source_sha256), status: row.status as ReceiptTemplateRecord["status"], createdAt: String(row.created_at),
    ...(row.validated_source_sha256 ? { validatedSourceSha256: String(row.validated_source_sha256) } : {}),
    ...(row.validation_json ? { validation: JSON.parse(String(row.validation_json)) } : {}),
    ...(row.activated_at ? { activatedAt: String(row.activated_at) } : {}), assets: getTemplateAssets(db, templateKey, version),
  };
}

export function getTemplateAssets(db: PosDatabase, templateKey: string, version: number): ReceiptAssetDescriptor[] {
  const rows = db.prepare("SELECT * FROM receipt_template_assets WHERE template_key=? AND template_version=? ORDER BY asset_id").all(templateKey, version) as Array<Record<string, unknown>>;
  return rows.map((row) => ({ assetId: String(row.asset_id), version: Number(row.asset_version), sha256: String(row.content_sha256), mime: "application/x-event-pos-mono-raster", widthDots: Number(row.width_dots), heightDots: Number(row.height_dots), rasterBase64: String(row.content_base64) }));
}

export function getReceiptTemplate(db: PosDatabase, templateKey: string, version: number): ReceiptTemplateRecord | undefined {
  const row = db.prepare("SELECT * FROM receipt_templates WHERE template_key=? AND version=?").get(templateKey, version) as Record<string, unknown> | undefined;
  return row ? rowToTemplate(db, row) : undefined;
}

export function getActiveReceiptTemplate(db: PosDatabase, templateKey = "sale-receipt"): ReceiptTemplateRecord {
  const row = db.prepare("SELECT * FROM receipt_templates WHERE template_key=? AND status='active'").get(templateKey) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`active templateがありません: ${templateKey}`);
  return rowToTemplate(db, row);
}

export function listReceiptTemplates(db: PosDatabase): ReceiptTemplateRecord[] {
  return (db.prepare("SELECT * FROM receipt_templates ORDER BY template_key,version DESC").all() as Array<Record<string, unknown>>).map((row) => rowToTemplate(db, row));
}

export function ensureDefaultReceiptTemplate(db: PosDatabase): void {
  const now = new Date().toISOString(); const validation = validateReceiptTemplate(DEFAULT_RECEIPT_TEMPLATE);
  const active = db.prepare("SELECT version,source_sha256 FROM receipt_templates WHERE template_key='sale-receipt' AND status='active'").get() as { version: number; source_sha256: string } | undefined;
  if (active?.source_sha256 === validation.sourceSha256) return;
  if (active && ![LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V2, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V3, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V4].some((template) => active.source_sha256 === sha256Hex(template))) return;
  const maximum = Number((db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM receipt_templates WHERE template_key='sale-receipt'").get() as { version: number }).version);
  const version = Math.max(DEFAULT_RECEIPT_TEMPLATE_VERSION, maximum + 1);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (active) db.prepare("UPDATE receipt_templates SET status='retired' WHERE template_key='sale-receipt' AND status='active'").run();
    db.prepare("INSERT INTO receipt_templates (template_key,version,source_text,source_sha256,status,validated_source_sha256,validation_json,validated_at,created_at,activated_at) VALUES ('sale-receipt',?,?,?,'active',?,?,?,?,?)")
      .run(version, DEFAULT_RECEIPT_TEMPLATE, validation.sourceSha256, validation.sourceSha256, JSON.stringify(validation), now, now, now);
    if (active) db.prepare("INSERT INTO audit_log (action,entity_type,entity_id,detail_json,created_at) VALUES ('receipt_template_default_upgrade','receipt_template',?,?,?)")
      .run(`sale-receipt:${version}`, JSON.stringify({ fromVersion: active.version, toVersion: version, sourceSha256: validation.sourceSha256, reason: "商品JANをレシートへ追加" }), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function createReceiptTemplateDraft(db: PosDatabase, input: { templateKey: string; sourceText: string; assets?: ReceiptAssetDescriptor[] }): ReceiptTemplateRecord {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(input.templateKey) || !input.sourceText) throw new Error("template key/sourceが不正です");
  const version = Number((db.prepare("SELECT COALESCE(MAX(version),0)+1 AS version FROM receipt_templates WHERE template_key=?").get(input.templateKey) as { version: number }).version); const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO receipt_templates (template_key,version,source_text,source_sha256,status,created_at) VALUES (?,?,?,?,'draft',?)").run(input.templateKey, version, input.sourceText, sha256Hex(input.sourceText), now);
    for (const asset of input.assets ?? []) db.prepare("INSERT INTO receipt_template_assets (template_key,template_version,asset_id,asset_version,mime,content_base64,content_sha256,width_dots,height_dots) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(input.templateKey, version, asset.assetId, asset.version, asset.mime, asset.rasterBase64, asset.sha256, asset.widthDots, asset.heightDots);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getReceiptTemplate(db, input.templateKey, version)!;
}

export function validateReceiptTemplateVersion(db: PosDatabase, templateKey: string, version: number): ReceiptTemplateRecord {
  const template = getReceiptTemplate(db, templateKey, version); if (!template) throw new Error("templateが見つかりません");
  const validation = validateReceiptTemplate(template.sourceText, template.assets, true); const now = new Date().toISOString();
  db.prepare("UPDATE receipt_templates SET validated_source_sha256=?,validation_json=?,validated_at=? WHERE template_key=? AND version=?").run(validation.sourceSha256, JSON.stringify(validation), now, templateKey, version);
  return getReceiptTemplate(db, templateKey, version)!;
}

export function activateReceiptTemplate(db: PosDatabase, templateKey: string, version: number, validatedSourceSha256: string): ReceiptTemplateRecord {
  const template = getReceiptTemplate(db, templateKey, version); if (!template) throw new Error("templateが見つかりません");
  if (!template.validatedSourceSha256 || template.validatedSourceSha256 !== validatedSourceSha256 || template.sourceSha256 !== validatedSourceSha256) throw new Error("validate済みsource SHA-256と一致しません");
  const now = new Date().toISOString(); db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE receipt_templates SET status='retired' WHERE template_key=? AND status='active'").run(templateKey);
    db.prepare("UPDATE receipt_templates SET status='active',activated_at=? WHERE template_key=? AND version=?").run(now, templateKey, version);
    db.prepare("INSERT INTO audit_log (action,entity_type,entity_id,detail_json,created_at) VALUES ('receipt_template_activate','receipt_template',?,?,?)").run(`${templateKey}:${version}`, JSON.stringify({ templateKey, version, sourceSha256: validatedSourceSha256 }), now);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return getReceiptTemplate(db, templateKey, version)!;
}

export function renderReceipt(db: PosDatabase, snapshot: ReceiptSnapshot, templateRef?: { templateKey: string; version: number }): ReceiptArtifacts {
  const template = templateRef ? getReceiptTemplate(db, templateRef.templateKey, templateRef.version) : getActiveReceiptTemplate(db);
  if (!template) throw new Error("templateが見つかりません");
  if (!template.validatedSourceSha256 || template.validatedSourceSha256 !== template.sourceSha256) throw new Error("template sourceがvalidate済みhashと一致しません");
  const compiled = compileReceiptTemplate(template.sourceText, snapshot, template.assets); const canonicalIr = canonicalizeReceiptDocument(compiled.document); const irSha256 = sha256Hex(canonicalIr);
  const escposBytes = receiptDocumentToEscPos(compiled.document, template.assets); const outputHash = bytesSha256(escposBytes);
  return { templateKey: template.templateKey, templateVersion: template.version, templateSourceSha256: template.sourceSha256, assets: template.assets, fontId: BUILTIN_FONT.id, fontVersion: BUILTIN_FONT.version, fontSha256: BUILTIN_FONT.sha256, rendererVersion: ESCPOS_RENDERER_VERSION, finishingPolicyId: DEFAULT_FINISHING_POLICY.id, finishingPolicyVersion: DEFAULT_FINISHING_POLICY.version, snapshot, canonicalIr, irSha256, escposBytes, bytesSha256: outputHash, humanReadable: compiled.humanReadable, warnings: compiled.warnings };
}

export function previewReceiptTemplate(db: PosDatabase, templateKey: string, version: number, snapshot: ReceiptSnapshot): { canonicalIr: string; irSha256: string; bytesSha256: string; warnings: string[]; humanReadable: string } {
  const artifacts = renderReceipt(db, snapshot, { templateKey, version });
  return { canonicalIr: artifacts.canonicalIr, irSha256: artifacts.irSha256, bytesSha256: artifacts.bytesSha256, warnings: artifacts.warnings, humanReadable: artifacts.humanReadable };
}

export function sampleReceiptSnapshot(): ReceiptSnapshot {
  return { schemaVersion: 1, eventName: "サンプルイベント", circleName: "サンプルサークル", transactionId: "00000000-0000-7000-8000-000000000000", publicReference: "1000-0015", transactionType: "sale", originalPublicReference: "", confirmedAt: "2026-08-02T03:00:00.000Z", confirmedAtPrinted: "2026-08-02 12:00", businessDate: "2026-08-02", registerNo: "1", staffPrintLabel: "001", lines: [{ productCode: "00000001", name: "新刊", quantity: 1, unitPriceYen: 500, unitPriceFormatted: "500", grossYen: 500, grossFormatted: "¥500", discountAllocatedYen: 0, discountFormatted: "¥0", taxYen: 45, taxFormatted: "¥45", netYen: 500, netFormatted: "¥500", taxRateBps: 1000 }], discounts: [], taxSummaries: [{ taxRateBps: 1000, taxableNetYen: 500, taxableNetFormatted: "¥500", taxYen: 45, taxFormatted: "¥45" }], payments: [{ methodName: "現金", amountYen: 500, amountFormatted: "¥500", tenderedYen: 1000, tenderedFormatted: "¥1,000", changeYen: 500, changeFormatted: "¥500" }], subtotalYen: 500, subtotalFormatted: "¥500", discountTotalYen: 0, discountTotalFormatted: "¥0", taxTotalYen: 45, taxTotalFormatted: "¥45", totalYen: 500, totalFormatted: "¥500", tenderedYen: 1000, tenderedFormatted: "¥1,000", changeYen: 500, changeFormatted: "¥500", isReprint: false, reprintLabel: "", reprintNo: 0, originalReceiptNumber: "", footer: "ありがとうございました", returnPolicy: "返品は責任者へお申し出ください", hasOriginalTransaction: false, hasDiscounts: false, hasTendered: true, hasChange: true };
}
