import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEFAULT_RECEIPT_TEMPLATE, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, validateReceiptTemplate, type ReceiptSnapshot } from "@event-pos/receipt-template";
import { buildApp } from "./app.js";
import { openDatabase, type PosDatabase } from "./db.js";
import { ensureDefaultReceiptTemplate, renderReceipt } from "./receipt-store.js";
import { openRegisterForTest } from "./test-support.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const catalog = {
  eventId: "receipt-event",
  customerWelcome: { circleName: "レシート試験サークル" },
  products: [{ productCode: "00000001", name: "日本語新刊", priceInclTax: 110, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }],
  quickEntries: [], autoDiscountRules: [],
  staffMembers: [{ staffId: "staff-001", responsibleNumber: "001", displayName: "試験管理者", receiptDisplay: "name", role: "admin" }],
};

function makeApp(): { app: FastifyInstance; db: PosDatabase } {
  const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app); return { app, db };
}

async function finalizeSale(app: FastifyInstance, saleCatalog = catalog): Promise<{ transactionId: string; printJobId: string }> {
  expect((await app.inject({ method: "PUT", url: `/api/v1/events/${saleCatalog.eventId}/catalog`, payload: saleCatalog })).statusCode).toBe(200);
  await openRegisterForTest(app, catalog.eventId, "2026-08-02", "register-1");
  let response = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: catalog.eventId, staffId: "staff-001", terminalId: "register-1", businessDate: "2026-08-02", sessionNo: 1 } });
  expect(response.statusCode).toBe(201); let draft = response.json();
  response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001", quantity: 1 } });
  expect(response.statusCode).toBe(201); draft = response.json();
  response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(draft.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 500 } });
  expect(response.statusCode).toBe(201); draft = response.json();
  response = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "receipt-route-test" }, payload: { version: draft.version } });
  expect(response.statusCode).toBe(201); return response.json();
}

function counts(db: PosDatabase): Record<string, number> {
  return Object.fromEntries(["transactions", "transaction_lines", "payments", "tax_summaries", "inventory_movements", "cash_movements"].map((table) => [table, Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]));
}

describe("receipt template and reprint routes", () => {
  it("旧defaultだけをJAN付きの新defaultへ自動移行する", () => {
    const db = openDatabase();
    db.prepare("DELETE FROM receipt_templates").run();
    const legacy = validateReceiptTemplate(LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1);
    db.prepare("INSERT INTO receipt_templates (template_key,version,source_text,source_sha256,status,validated_source_sha256,validation_json,validated_at,created_at,activated_at) VALUES ('sale-receipt',1,?,?, 'active',?,?,?,?,?)")
      .run(LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, legacy.sourceSha256, legacy.sourceSha256, JSON.stringify(legacy), "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z");
    ensureDefaultReceiptTemplate(db);
    const active = db.prepare("SELECT version,source_text FROM receipt_templates WHERE template_key='sale-receipt' AND status='active'").get() as { version: number; source_text: string };
    expect(active.version).toBe(7);
    expect(active.source_text).toContain("feedLines: 8");
    expect(active.source_text).toContain('text: "JAN {{productCode}}"');
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='receipt_template_default_upgrade'").get()).toEqual({ count: 1 });
  });

  it("drawer未受入時は手動駆動APIも拒否する", async () => {
    const { app, db } = makeApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DRAWER_NOT_ACCEPTED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toEqual({ count: 0 });
  });

  it("責任者の既定drawer profileを80msで監査付き保存する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, drawerEnabled: true }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } });
    expect(response.statusCode).toBe(201);
    expect(response.json().payload).toMatchObject({ pin: 2, onMs: 80, offMs: 400, reason: "manager_manual" });
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='drawer_open_request'").get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({ actorId: "manager-1", profile: "approved", pin: 2, onMs: 80, offMs: 400 });
  });

  it("会計時にPIIを含まないimmutable snapshotと全version/hashを保存する", async () => {
    const { app, db } = makeApp(); const sale = await finalizeSale(app);
    const row = db.prepare("SELECT * FROM print_jobs WHERE job_id=?").get(sale.printJobId) as Record<string, unknown>;
    const snapshot = JSON.parse(String(row.receipt_snapshot_json)) as ReceiptSnapshot;
    expect(snapshot).toMatchObject({ schemaVersion: 1, transactionId: sale.transactionId, eventName: catalog.eventId, circleName: "レシート試験サークル", registerNo: "1", staffPrintLabel: "試験管理者", totalYen: 110, tenderedYen: 500, changeYen: 390, isReprint: false });
    expect(snapshot.lines).toEqual([expect.objectContaining({ productCode: "00000001", name: "日本語新刊", quantity: 1, unitPriceYen: 110, taxRateBps: 1000 })]);
    expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining(["birthDate", "idNumber", "ageVerification"]));
    expect(row).toMatchObject({ kind: "original", state: "pending", delivery_certainty: "not_sent", template_key: "sale-receipt", template_version: 7, font_version: 1, finishing_policy_version: 2 });
    for (const key of ["template_source_sha256", "renderer_version", "font_id", "font_sha256", "finishing_policy_id", "canonical_ir", "ir_sha256", "bytes_sha256"]) expect(String(row[key])).not.toHaveLength(0);
    expect(Number(row.expected_bytes_length)).toBe((row.escpos_bytes as Uint8Array).length);
    expect(String(row.canonical_ir)).toContain('!text "JAN 00000001"');
    expect(String(row.canonical_ir)).toContain('!row {"left":"単¥110 × 1","right":"¥110"}');
    expect(String(row.canonical_ir)).toContain("!barcode");
    expect(String(row.canonical_ir)).toContain("!feed 8");
  });

  it("draft→validate→preview→activateをSHA拘束し、旧jobは旧versionから同一bytesを再生成する", async () => {
    const { app, db } = makeApp(); const sale = await finalizeSale(app);
    const source = db.prepare("SELECT * FROM print_jobs WHERE job_id=?").get(sale.printJobId) as Record<string, unknown>;
    const badDraft = await app.inject({ method: "POST", url: "/api/v1/receipt-templates", payload: { templateKey: "sale-receipt", sourceText: "schemaVersion: 1\nbody:\n  - raw: true\n" } });
    expect(badDraft.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${badDraft.json().version}/validate` })).statusCode).toBe(422);

    const v2Source = DEFAULT_RECEIPT_TEMPLATE.replace('  - text: "{{footer}}"', '  - text: "template v2"\n  - text: "{{footer}}"');
    const draft = await app.inject({ method: "POST", url: "/api/v1/receipt-templates", payload: { templateKey: "sale-receipt", sourceText: v2Source } });
    expect(draft.statusCode).toBe(201); const version = Number(draft.json().version);
    const validated = await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${version}/validate` });
    expect(validated.statusCode).toBe(200); const sha = validated.json().validatedSourceSha256;
    const preview = await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${version}/preview`, payload: {} });
    expect(preview.statusCode).toBe(200); expect(preview.json().humanReadable).toContain("template v2");
    expect((await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${version}/activate`, payload: { sourceSha256: "wrong" } })).statusCode).toBe(409);
    const activated = await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${version}/activate`, payload: { sourceSha256: sha } });
    expect(activated.statusCode).toBe(200); expect(activated.json()).toMatchObject({ status: "active", sourceSha256: sha });

    const snapshot = JSON.parse(String(source.receipt_snapshot_json)) as ReceiptSnapshot;
    const regenerated = renderReceipt(db, snapshot, { templateKey: String(source.template_key), version: Number(source.template_version) });
    expect(regenerated.canonicalIr).toBe(source.canonical_ir);
    expect(regenerated.irSha256).toBe(source.ir_sha256);
    expect(regenerated.bytesSha256).toBe(source.bytes_sha256);
    expect(Array.from(regenerated.escposBytes)).toEqual(Array.from(source.escpos_bytes as Uint8Array));
  });

  it("下書きのテスト印刷をjobとして登録し、存在しない版は404にする", async () => {
    const { app } = makeApp();
    const draft = await app.inject({ method: "POST", url: "/api/v1/receipt-templates", payload: { templateKey: "sale-receipt", sourceText: DEFAULT_RECEIPT_TEMPLATE } });
    expect(draft.statusCode).toBe(201);
    const version = Number(draft.json().version);
    const response = await app.inject({ method: "POST", url: `/api/v1/receipt-templates/sale-receipt/${version}/test-print`, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: {} });
    expect(response.statusCode, response.body).toBe(201);
    const job = response.json(); const bytes = Buffer.from(job.payload.escposBase64, "base64");
    expect(job).toMatchObject({ kind: "test", transactionId: expect.stringMatching(/^template-test:/) });
    expect(bytes.length).toBe(job.expectedBytesLength);
    expect(bytes.toString("hex")).not.toHaveLength(0);
    expect(job.bytesSha256).toBe((await import("node:crypto")).createHash("sha256").update(bytes).digest("hex"));
    expect((await app.inject({ method: "POST", url: "/api/v1/receipt-templates/sale-receipt/999999/test-print", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: {} })).statusCode).toBe(404);
  });

  it("再印刷は責任者・実物結果・二重印刷リスク承認を要求し、会計を変更せず新jobと監査を作る", async () => {
    const { app, db } = makeApp(); const sale = await finalizeSale(app); const beforeCounts = counts(db);
    const sourceBefore = db.prepare("SELECT state,receipt_snapshot_json,bytes_sha256,template_version FROM print_jobs WHERE job_id=?").get(sale.printJobId);
    const url = `/api/v1/transactions/${sale.transactionId}/reprints`;
    const base = { sourcePrintJobId: sale.printJobId, reason: "お客様控え紛失", physicalOutcome: "printed", riskAccepted: true };
    expect((await app.inject({ method: "POST", url, payload: base })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: base })).statusCode).toBe(409);
    const response = await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: { ...base, approval: { approverId: "manager-1", approvedAt: "2026-08-02T06:00:00.000Z" } } });
    expect(response.statusCode, response.body).toBe(201);
    const reprint = response.json();
    expect(reprint).toMatchObject({ transactionId: sale.transactionId, kind: "reprint", sourceJobId: sale.printJobId, reprintNo: 1, state: "pending", deliveryCertainty: "not_sent", templateVersion: 7 });
    expect(counts(db)).toEqual(beforeCounts);
    expect(db.prepare("SELECT state,receipt_snapshot_json,bytes_sha256,template_version FROM print_jobs WHERE job_id=?").get(sale.printJobId)).toEqual(sourceBefore);
    const reprintSnapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE job_id=?").get(reprint.jobId) as { receipt_snapshot_json: string }).receipt_snapshot_json)) as ReceiptSnapshot;
    expect(reprintSnapshot).toMatchObject({ transactionId: sale.transactionId, isReprint: true, reprintLabel: "再印刷", reprintNo: 1, originalReceiptNumber: expect.any(String) });
    const approval = db.prepare("SELECT executor_id,approver_id,self_approved,risk_accepted FROM print_approvals WHERE subject_job_id=?").get(sale.printJobId);
    expect(approval).toEqual({ executor_id: "manager-1", approver_id: "manager-1", self_approved: 1, risk_accepted: 1 });
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='receipt_reprint' AND entity_id=?").get(reprint.jobId) as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({ sourcePrintJobId: sale.printJobId, self_approved: true, physicalOutcome: "printed", riskAccepted: true });
  });

  it("カタログのcommonText.reprintLabelを再印刷スナップショットへ反映する", async () => {
    const { app, db } = makeApp();
    const configuredCatalog = { ...catalog, receiptSettings: { templates: {}, commonText: { reprintLabel: "控え再発行" } } };
    const sale = await finalizeSale(app, configuredCatalog);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/transactions/${sale.transactionId}/reprints`,
      headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" },
      payload: { sourcePrintJobId: sale.printJobId, reason: "ラベル設定確認", physicalOutcome: "not_printed", riskAccepted: false },
    });
    expect(response.statusCode, response.body).toBe(201);
    const snapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE job_id=?").get(response.json().jobId) as { receipt_snapshot_json: string }).receipt_snapshot_json)) as ReceiptSnapshot;
    expect(snapshot).toMatchObject({ reprintLabel: "控え再発行", reprintNo: 1 });
  });
});
