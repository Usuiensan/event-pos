import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { ESCPOS_RENDERER_VERSION, ESCPOS_RENDERER_VERSION_ROTATE180, canonicalIrToEscPos } from "@event-pos/escpos";
import { DEFAULT_RECEIPT_TEMPLATE, LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, validateReceiptTemplate, type ReceiptSnapshot } from "@event-pos/receipt-template";
import { buildApp } from "./app.js";
import { getPrintJob, openDatabase, type PosDatabase } from "./db.js";
import { ensureDefaultReceiptTemplate, renderReceipt } from "./receipt-store.js";
import { openRegisterForTest, signInForTest } from "./test-support.js";
import { PrinterHostFailure } from "./print-queue.js";

const apps: FastifyInstance[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  while (apps.length) await apps.pop()!.close();
});

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

// 再印刷の前提として、元ジョブを印字済み（終端状態）にする（F-094: 処理中ジョブへの再印刷は拒否される）。
function completeSourceJob(db: PosDatabase, jobId: string): void {
  db.prepare("UPDATE print_jobs SET state='completed' WHERE job_id=?").run(jobId);
}

function counts(db: PosDatabase): Record<string, number> {
  return Object.fromEntries(["transactions", "transaction_lines", "payments", "tax_summaries", "inventory_movements", "cash_movements"].map((table) => [table, Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count)]));
}

describe("receipt template and reprint routes", () => {
  it("旧defaultだけを品番・返品バーコード付きの新defaultへ自動移行する", () => {
    const db = openDatabase();
    db.prepare("DELETE FROM receipt_templates").run();
    const legacy = validateReceiptTemplate(LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1);
    db.prepare("INSERT INTO receipt_templates (template_key,version,source_text,source_sha256,status,validated_source_sha256,validation_json,validated_at,created_at,activated_at) VALUES ('sale-receipt',1,?,?, 'active',?,?,?,?,?)")
      .run(LEGACY_DEFAULT_RECEIPT_TEMPLATE_V1, legacy.sourceSha256, legacy.sourceSha256, JSON.stringify(legacy), "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z", "2026-08-03T00:00:00.000Z");
    ensureDefaultReceiptTemplate(db);
    const active = db.prepare("SELECT version,source_text FROM receipt_templates WHERE template_key='sale-receipt' AND status='active'").get() as { version: number; source_text: string };
    expect(active.version).toBe(10);
    expect(active.source_text).toContain("feed: 4");
    expect(active.source_text).toContain('text: "品番 {{productCode}}"');
    expect(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='receipt_template_default_upgrade'").get()).toEqual({ count: 1 });
  });

  it("drawer未受入時は手動駆動APIも拒否する", async () => {
    const { app, db } = makeApp();
    const response = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("DRAWER_NOT_ACCEPTED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toEqual({ count: 0 });
  });

  it("PrinterHost未設定時はdrawer jobを成功扱いせず拒否する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, drawerEnabled: true }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("PRINTER_HOST_NOT_CONFIGURED");
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toEqual({ count: 0 });
  });

  it("PrinterHost切断時はdrawer jobを保存せず再試行可能なエラーを返す", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, drawerEnabled: true, printerHost: { accept: async () => { throw new Error("unreachable"); }, getStatus: async () => ({ observedAt: new Date().toISOString(), reachable: { support: "supported", value: false }, online: { support: "unknown", reason: "offline" }, coverOpen: { support: "unknown", reason: "offline" }, drawerOpen: { support: "unknown", reason: "offline" }, paper: { support: "unknown", reason: "offline" }, error: { support: "unknown", reason: "offline" }, raw: null }) } }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" } });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("PRINTER_HOST_UNAVAILABLE");
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE document_type='drawer'").get()).toEqual({ count: 0 });
  });

  it("接続済みPrinterHostへ責任者の既定drawer profileを80msで監査付き送信する", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, drawerEnabled: true, printerHost: { accept: async (job) => ({ jobId: job.jobId, acceptedBytes: job.expectedBytesLength!, payloadLength: job.expectedBytesLength!, bytesSha256: job.bytesSha256!, completionEvidence: "transport_accepted", duplicate: false }), getStatus: async () => ({ observedAt: new Date().toISOString(), reachable: { support: "supported", value: true }, online: { support: "unknown", reason: "status not available" }, coverOpen: { support: "unknown", reason: "status not available" }, drawerOpen: { support: "unknown", reason: "status not available" }, paper: { support: "unknown", reason: "status not available" }, error: { support: "unknown", reason: "status not available" }, raw: null }) } }); apps.push(app);
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
    expect(row).toMatchObject({ kind: "original", state: "pending", delivery_certainty: "not_sent", template_key: "sale-receipt", template_version: 10, font_version: 1, finishing_policy_version: 2 });
    for (const key of ["template_source_sha256", "renderer_version", "font_id", "font_sha256", "finishing_policy_id", "canonical_ir", "ir_sha256", "bytes_sha256"]) expect(String(row[key])).not.toHaveLength(0);
    expect(Number(row.expected_bytes_length)).toBe((row.escpos_bytes as Uint8Array).length);
    expect(String(row.canonical_ir)).toContain('!text "品番 00000001"');
    expect(String(row.canonical_ir)).toContain('!row {"left":"単110 × 1","right":"¥110"}');
    expect(String(row.canonical_ir)).toContain("!barcode");
    expect(String(row.canonical_ir)).toContain("!feed 2");
    expect(String(row.canonical_ir)).toContain("!feed 4");
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
    const { app, db } = makeApp(); const sale = await finalizeSale(app); completeSourceJob(db, sale.printJobId); const beforeCounts = counts(db);
    const sourceBefore = db.prepare("SELECT state,receipt_snapshot_json,bytes_sha256,template_version FROM print_jobs WHERE job_id=?").get(sale.printJobId);
    const url = `/api/v1/transactions/${sale.transactionId}/reprints`;
    const base = { sourcePrintJobId: sale.printJobId, reason: "お客様控え紛失", physicalOutcome: "printed", riskAccepted: true };
    expect((await app.inject({ method: "POST", url, payload: base })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: base })).statusCode).toBe(409);
    const response = await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: { ...base, approval: { approverId: "manager-1", approvedAt: "2026-08-02T06:00:00.000Z" } } });
    expect(response.statusCode, response.body).toBe(201);
    const reprint = response.json();
    expect(reprint).toMatchObject({ transactionId: sale.transactionId, kind: "reprint", sourceJobId: sale.printJobId, reprintNo: 1, state: "pending", deliveryCertainty: "not_sent", templateVersion: 10 });
    expect(counts(db)).toEqual(beforeCounts);
    expect(db.prepare("SELECT state,receipt_snapshot_json,bytes_sha256,template_version FROM print_jobs WHERE job_id=?").get(sale.printJobId)).toEqual(sourceBefore);
    const reprintSnapshot = JSON.parse(String((db.prepare("SELECT receipt_snapshot_json FROM print_jobs WHERE job_id=?").get(reprint.jobId) as { receipt_snapshot_json: string }).receipt_snapshot_json)) as ReceiptSnapshot;
    expect(reprintSnapshot).toMatchObject({ transactionId: sale.transactionId, isReprint: true, reprintLabel: "再印刷", reprintNo: 1, originalReceiptNumber: expect.any(String) });
    const approval = db.prepare("SELECT executor_id,approver_id,self_approved,risk_accepted FROM print_approvals WHERE subject_job_id=?").get(sale.printJobId);
    expect(approval).toEqual({ executor_id: "manager-1", approver_id: "manager-1", self_approved: 1, risk_accepted: 1 });
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='receipt_reprint' AND entity_id=?").get(reprint.jobId) as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({ sourcePrintJobId: sale.printJobId, self_approved: true, physicalOutcome: "printed", riskAccepted: true });
  });

  it("処理中（待機・送信中・再試行待ち）の元ジョブへの再印刷は拒否する (F-094)", async () => {
    const { app, db } = makeApp(); const sale = await finalizeSale(app);
    const url = `/api/v1/transactions/${sale.transactionId}/reprints`;
    const body = { sourcePrintJobId: sale.printJobId, reason: "状態確認", physicalOutcome: "not_printed", riskAccepted: false };
    for (const state of ["pending", "sending", "retry_wait"]) {
      db.prepare("UPDATE print_jobs SET state=? WHERE job_id=?").run(state, sale.printJobId);
      const response = await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: body });
      expect(response.statusCode, `${state}: ${response.body}`).toBe(409);
      expect(response.json().error.code).toBe("SOURCE_PRINT_JOB_IN_PROGRESS");
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE kind='reprint'").get()).toEqual({ count: 0 });
  });

  it.each([
    ["0", "1", ESCPOS_RENDERER_VERSION],
    ["1", "0", ESCPOS_RENDERER_VERSION_ROTATE180],
  ])("回転設定が %s→%s に変わっても、結果不明のレシートを承認付きで元の向きに再印刷する", async (before, after, rendererVersion) => {
    vi.stubEnv("RECEIPT_ROTATE_180", before);
    const db = openDatabase();
    const dispatched: string[] = [];
    const app = buildApp({ database: db, printerHost: { accept: async (job) => {
      dispatched.push(job.jobId);
      if (job.kind === "original") {
        throw new PrinterHostFailure({
          code: "SHORT_WRITE", message: "テスト用の途中切断", acceptedBytes: 3,
          retryable: true, notSentProven: false, deviceFault: false,
        });
      }
      return {
        jobId: job.jobId, acceptedBytes: job.expectedBytesLength!, payloadLength: job.expectedBytesLength!,
        bytesSha256: job.bytesSha256!, completionEvidence: "transport_accepted", duplicate: false,
      };
    } } });
    apps.push(app);
    const { transactionId, printJobId } = await finalizeSale(app);
    await expect.poll(() => getPrintJob(db, printJobId)).toMatchObject({
      state: "failed", deliveryCertainty: "unknown", rendererVersion,
    });
    const sourceJob = db.prepare("SELECT * FROM print_jobs WHERE job_id=?");
    const sourceBefore = sourceJob.get(printJobId);
    const attempts = db.prepare("SELECT * FROM print_attempts WHERE job_id=? ORDER BY attempt_no");
    const attemptsBefore = attempts.all(printJobId);
    expect(attemptsBefore).toMatchObject([{ attempt_no: 1, accepted_bytes: 3, result: "unknown" }]);
    const reprints = db.prepare("SELECT job_id FROM print_jobs WHERE transaction_id=? AND kind='reprint'");
    const audits = db.prepare("SELECT entity_id, detail_json FROM audit_log WHERE action='receipt_reprint'");

    vi.stubEnv("RECEIPT_ROTATE_180", after);
    // 開局時の opening 印刷も同じ PrinterHost へ送られるため、再印刷前の送信は
    // 「元ジョブが送られていること」で確認する（F-086）。
    expect(dispatched).toContain(printJobId);
    const dispatchedBeforeReprint = dispatched.length;
    expect(reprints.all(transactionId)).toEqual([]);
    const request = {
      method: "POST" as const,
      url: `/api/v1/transactions/${transactionId}/reprints`,
      headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" },
    };
    const payload = { sourcePrintJobId: printJobId, reason: "紙面未確認", physicalOutcome: "indeterminate", riskAccepted: true };
    const denied = await app.inject({ ...request, payload });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("REPRINT_RISK_APPROVAL_REQUIRED");
    expect(reprints.all(transactionId)).toEqual([]);
    expect(audits.all()).toEqual([]);

    const response = await app.inject({
      ...request,
      payload: { ...payload, approval: { approverId: "manager-1", approvedAt: "2026-08-02T06:00:00.000Z" } },
    });
    expect(response.statusCode, response.body).toBe(201);
    const { jobId } = response.json();
    await expect.poll(() => getPrintJob(db, jobId)).toMatchObject({
      state: "completed", kind: "reprint", sourceJobId: printJobId, reprintNo: 1, rendererVersion,
    });
    const { canonical_ir, escpos_bytes } = sourceJob.get(jobId) as { canonical_ir: string; escpos_bytes: Uint8Array };
    expect(escpos_bytes).toEqual(canonicalIrToEscPos(canonical_ir, [], { rotate180: before === "1" }));
    expect(reprints.all(transactionId)).toEqual([{ job_id: jobId }]);
    expect(audits.all()).toEqual([{ entity_id: jobId, detail_json: expect.any(String) }]);
    const audit = audits.get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json)).toMatchObject({
      sourcePrintJobId: printJobId, transactionId, reprintNo: 1, approverId: "manager-1",
      physicalOutcome: "indeterminate", riskAccepted: true,
    });
    expect(counts(db).transactions).toBe(1);
    expect(sourceJob.get(printJobId)).toEqual(sourceBefore);
    expect(attempts.all(printJobId)).toEqual(attemptsBefore);
    expect(dispatched).toHaveLength(dispatchedBeforeReprint + 1);
    expect(dispatched.at(-1)).toBe(jobId);
  });

  it.each([
    ["template_source_sha256", "0".repeat(64)],
    ["asset_manifest_json", JSON.stringify([{ assetId: "old-logo", version: 1, sha256: "0".repeat(64), widthDots: 8, heightDots: 1 }])],
    ["font_sha256", "0".repeat(64)],
    ["finishing_policy_version", 1],
    ["renderer_version", "event-pos-escpos-unsupported"],
  ])("元ジョブの %s を再現できない場合は再印刷を拒否する", async (column, value) => {
    const { app, db } = makeApp();
    const { transactionId, printJobId } = await finalizeSale(app);
    completeSourceJob(db, printJobId);
    db.prepare(`UPDATE print_jobs SET ${column}=? WHERE job_id=?`).run(value, printJobId);
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/transactions/${transactionId}/reprints`,
      headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" },
      payload: { sourcePrintJobId: printJobId, reason: "紙面なしを確認", physicalOutcome: "not_printed", riskAccepted: false },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SOURCE_VERSION_MISMATCH");
    expect(db.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE kind='reprint'").get()).toEqual({ count: 0 });
  });

  it("カタログのcommonText.reprintLabelを再印刷スナップショットへ反映する", async () => {
    const { app, db } = makeApp();
    const configuredCatalog = { ...catalog, receiptSettings: { templates: {}, commonText: { reprintLabel: "控え再発行" } } };
    const sale = await finalizeSale(app, configuredCatalog);
    completeSourceJob(db, sale.printJobId);
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

describe("print job cancel kicks the queue (F-037)", () => {
  it("機器障害で止まった先頭ジョブを取り消すと、後続ジョブが送信される", async () => {
    const sent: string[] = [];
    const db = openDatabase();
    const app = buildApp({ database: db, printerHost: { accept: async (job) => {
      sent.push(job.jobId);
      if (job.jobId === "head") throw new PrinterHostFailure({ code: "PAPER_OUT", message: "用紙切れ", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: true });
      return { jobId: job.jobId, bytesSha256: job.bytesSha256!, payloadLength: job.expectedBytesLength!, acceptedBytes: job.expectedBytesLength!, completionEvidence: "transport_accepted" as const, duplicate: false };
    } } });
    apps.push(app);
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog })).statusCode).toBe(200);
    const enqueue = async (jobId: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId, transactionId: `print-test:${jobId}`, printerId: "receipt-1", documentType: "receipt", createdAt: new Date().toISOString(), source: "test", payload: { escposBase64: "G0A=" } } });
      expect(response.statusCode, response.body).toBe(201);
    };
    const state = async (jobId: string) => (await app.inject({ method: "GET", url: `/api/v1/print-jobs/${jobId}` })).json().state as string;
    const waitState = async (jobId: string, expected: string) => {
      let current = "";
      for (let i = 0; i < 40; i++) { current = await state(jobId); if (current === expected) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
      return current;
    };
    await enqueue("head");
    await enqueue("next");
    expect(await waitState("head", "retry_wait")).toBe("retry_wait");
    expect(await state("next")).toBe("pending");
    const cancel = await app.inject({ method: "POST", url: "/api/v1/print-jobs/head/cancel" });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(cancel.json().state).toBe("canceled");
    expect(await waitState("next", "completed")).toBe("completed");
    expect(sent).toEqual(["head", "next"]);
  });
});

describe("印刷操作は認証必須時にセッション担当者を要求する (F-069)", () => {
  const reachableStatus = async () => ({ observedAt: new Date().toISOString(), reachable: { support: "supported" as const, value: true }, online: { support: "unknown" as const, reason: "n/a" }, coverOpen: { support: "unknown" as const, reason: "n/a" }, drawerOpen: { support: "unknown" as const, reason: "n/a" }, paper: { support: "unknown" as const, reason: "n/a" }, error: { support: "unknown" as const, reason: "n/a" }, raw: null });
  const acceptOk = async (job: { jobId: string; expectedBytesLength?: number | null; bytesSha256?: string | null }) => ({ jobId: job.jobId, acceptedBytes: job.expectedBytesLength!, payloadLength: job.expectedBytesLength!, bytesSha256: job.bytesSha256!, completionEvidence: "transport_accepted" as const, duplicate: false });

  it("drawerは偽ヘッダーを拒否し、managerセッションだけを通す", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true, drawerEnabled: true, printerHost: { accept: acceptOk, getStatus: reachableStatus } }); apps.push(app);
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: { "x-pos-role": "manager", "x-pos-actor-id": "999" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer" })).statusCode).toBe(401);
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const ok = await app.inject({ method: "POST", url: "/api/v1/device-jobs/drawer", headers: manager });
    expect(ok.statusCode, ok.body).toBe(201);
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='drawer_open_request'").get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json).actorId).toBe("001");
  });

  it("再印刷は偽ヘッダーを拒否し、認証済み担当者で実行できる", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog })).statusCode).toBe(200);
    const admin = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const business = await app.inject({ method: "POST", url: "/api/v1/business-sessions", headers: admin, payload: { eventId: catalog.eventId, businessDate: "2026-08-02", terminalId: "register-1" } });
    expect(business.statusCode, business.body).toBe(201);
    const prepared = await app.inject({ method: "POST", url: `/api/v1/business-sessions/${business.json().businessSessionId}/registers/register-1/prepare`, headers: admin, payload: { terminalId: "register-1" } });
    expect(prepared.statusCode, prepared.body).toBe(201);
    const opened = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${encodeURIComponent(prepared.json().sessionId)}/checks/opening`, headers: { ...admin, "idempotency-key": "f069-opening" }, payload: { counted: [], terminalId: "register-1" } });
    expect(opened.statusCode, opened.body).toBe(201);
    let res = await app.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", headers: admin, payload: { eventId: catalog.eventId, staffId: "staff-001", terminalId: "register-1", businessDate: "2026-08-02", sessionNo: 1 } });
    expect(res.statusCode, res.body).toBe(201); let draft = res.json();
    res = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { ...admin, "if-match": String(draft.version) }, payload: { productCode: "00000001", quantity: 1 } });
    expect(res.statusCode, res.body).toBe(201); draft = res.json();
    res = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { ...admin, "if-match": String(draft.version) }, payload: { kind: "cash", amountYen: 110, tenderedYen: 500 } });
    expect(res.statusCode, res.body).toBe(201); draft = res.json();
    res = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { ...admin, "idempotency-key": "f069-sale" }, payload: { version: draft.version } });
    expect(res.statusCode, res.body).toBe(201);
    const sale = res.json() as { transactionId: string; printJobId: string };
    completeSourceJob(db, sale.printJobId);
    const url = `/api/v1/transactions/${sale.transactionId}/reprints`;
    const body = { sourcePrintJobId: sale.printJobId, reason: "紛失", physicalOutcome: "not_printed", riskAccepted: false };
    expect((await app.inject({ method: "POST", url, headers: { "x-pos-role": "manager", "x-pos-actor-id": "999" }, payload: body })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url, headers: admin, payload: body });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("待機取消は無認証を拒否し、operatorセッションで実行できる", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true }); apps.push(app);
    const operatorCatalog = { ...catalog, staffMembers: [...catalog.staffMembers, { staffId: "staff-003", responsibleNumber: "003", displayName: "担当者", receiptDisplay: "name", role: "operator" }] };
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: operatorCatalog })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId: "f069-cancel", transactionId: "f069-tx", printerId: "receipt-1", documentType: "receipt", payload: { escposBase64: "G0A=" }, createdAt: new Date().toISOString(), source: "test" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/print-jobs/f069-cancel/cancel" })).statusCode).toBe(401);
    const operator = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "003", terminalId: "register-1" });
    const ok = await app.inject({ method: "POST", url: "/api/v1/print-jobs/f069-cancel/cancel", headers: operator });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().state).toBe("canceled");
  });

  it("キュー再開は無認証を拒否し、managerセッションで実行できる", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, requireAuth: true, printerHost: { accept: async () => { throw new PrinterHostFailure({ code: "PAPER_OUT", message: "用紙切れ", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: true }); }, getStatus: reachableStatus } }); apps.push(app);
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId: "f069-block", transactionId: "f069-tx-block", printerId: "receipt-1", documentType: "receipt", payload: { escposBase64: "G0A=" }, createdAt: new Date().toISOString(), source: "test" } })).statusCode).toBe(201);
    for (let i = 0; i < 40; i++) { const queue = (await app.inject({ method: "GET", url: "/api/v1/printer/status" })).json().queue; if (queue.blocked) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect((await app.inject({ method: "POST", url: "/api/v1/printer/resume", payload: { actorId: "attacker" } })).statusCode).toBe(401);
    const manager = await signInForTest(app, { eventId: catalog.eventId, responsibleNumber: "001", terminalId: "register-1" });
    const ok = await app.inject({ method: "POST", url: "/api/v1/printer/resume", headers: manager, payload: {} });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ resumed: true });
    const audit = db.prepare("SELECT detail_json FROM audit_log WHERE action='printer_resume'").get() as { detail_json: string };
    expect(JSON.parse(audit.detail_json).actorId).toBe("001");
  });
});

describe("printer status route exposes the queue block (F-057)", () => {
  it("device faultで停止中は、状態APIが停止と理由を返す", async () => {
    const db = openDatabase();
    const app = buildApp({ database: db, printerHost: { accept: async (job) => {
      throw new PrinterHostFailure({ code: "PAPER_OUT", message: "用紙切れのため送信できません", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: true });
    } } });
    apps.push(app);
    const queueStatus = async () => (await app.inject({ method: "GET", url: "/api/v1/printer/status" })).json().queue;
    expect(await queueStatus()).toEqual({ blocked: false, blockReason: null, jobId: null, errorMessage: null, waitingJobs: 0 });
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${catalog.eventId}/catalog`, payload: catalog })).statusCode).toBe(200);
    const enqueue = async (jobId: string) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId, transactionId: `print-test:${jobId}`, printerId: "receipt-1", documentType: "receipt", createdAt: new Date().toISOString(), source: "test", payload: { escposBase64: "G0A=" } } });
      expect(response.statusCode, response.body).toBe(201);
    };
    await enqueue("head");
    await enqueue("next");
    let queue: unknown;
    for (let i = 0; i < 40; i++) { queue = await queueStatus(); if ((queue as { blocked: boolean }).blocked) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
    expect(queue).toEqual({ blocked: true, blockReason: "device_fault", jobId: "head", errorMessage: "用紙切れのため送信できません", waitingJobs: 2 });
  });
});

describe("printer status route exposes drawerEnabled (F-059)", () => {
  it("drawerEnabled未指定（USBキット既定）は状態APIがfalseを返す", async () => {
    const { app } = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/v1/printer/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().drawerEnabled).toBe(false);
  });

  it("drawerEnabled有効時は状態APIがtrueを返す", async () => {
    const db = openDatabase(); const app = buildApp({ database: db, drawerEnabled: true }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/printer/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json().drawerEnabled).toBe(true);
  });
});
