import type { FastifyInstance, FastifyReply } from "fastify";
import type { PrinterStatusObservation } from "@event-pos/contracts";
import { importEventCatalog } from "@event-pos/contracts";
import type { PrintJob } from "@event-pos/contracts";
import type { ReceiptSnapshot } from "@event-pos/receipt-template";
import { uuidV7 } from "./checkout-store.js";
import { getCatalog, getPrintJob, type PosDatabase } from "./db.js";
import { getPrintQueueStatus, type PersistentPrintQueue } from "./print-queue.js";
import { activateReceiptTemplate, createReceiptTemplateDraft, getReceiptTemplate, listReceiptTemplates, previewReceiptTemplate, renderReceipt, sampleReceiptSnapshot, validateReceiptTemplateVersion } from "./receipt-store.js";
import { createPrintJob } from "./db.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { bytesSha256 } from "@event-pos/escpos";

type PhysicalOutcome = "printed" | "not_printed" | "indeterminate";
type ReprintBody = { sourcePrintJobId: string; reason: string; physicalOutcome: PhysicalOutcome; riskAccepted: boolean; approval?: { approverId: string; approvedAt: string } };
type DrawerPulseProfile = "approved" | "pin2_40ms" | "pin2_80ms" | "pin5_40ms" | "pin5_80ms";

const drawerPulse = (pin: 2 | 5, onMs: number, offMs: number) => {
  const bytes = Uint8Array.from([0x1b, 0x70, pin === 2 ? 0 : 1, onMs / 2, offMs / 2]);
  return { pin, onMs, offMs, bytesSha256: bytesSha256(bytes) };
};
const drawerPulseProfiles: Record<DrawerPulseProfile, ReturnType<typeof drawerPulse>> = {
  approved: drawerPulse(2, 80, 400),
  pin2_40ms: drawerPulse(2, 40, 200),
  pin2_80ms: drawerPulse(2, 80, 400),
  pin5_40ms: drawerPulse(5, 40, 200),
  pin5_80ms: drawerPulse(5, 80, 400),
};

function error(reply: FastifyReply, status: number, code: string, message: string): unknown { return reply.code(status).send({ error: { code, message, details: {}, requestId: reply.request.id } }); }
function header(request: { headers: Record<string, string | string[] | undefined> }, name: string): string | undefined { const value = request.headers[name]; return Array.isArray(value) ? value[0] : value; }

function insertReprint(db: PosDatabase, transactionId: string, body: ReprintBody, executorId: string): PrintJob {
  if (!body?.sourcePrintJobId || !body.reason?.trim() || !["printed", "not_printed", "indeterminate"].includes(body.physicalOutcome) || typeof body.riskAccepted !== "boolean") throw new Error("REPRINT_INPUT_REQUIRED");
  const sourceRow = db.prepare("SELECT * FROM print_jobs WHERE job_id=? AND transaction_id=?").get(body.sourcePrintJobId, transactionId) as Record<string, unknown> | undefined;
  if (!sourceRow || !sourceRow.receipt_snapshot_json || !sourceRow.template_key || !sourceRow.template_version) throw new Error("SOURCE_PRINT_JOB_NOT_FOUND");
  const requiresRiskApproval = body.physicalOutcome === "printed" || body.physicalOutcome === "indeterminate";
  if (requiresRiskApproval && (!body.riskAccepted || !body.approval?.approverId || !body.approval.approvedAt)) throw new Error("REPRINT_RISK_APPROVAL_REQUIRED");
  const sourceSnapshot = JSON.parse(String(sourceRow.receipt_snapshot_json)) as ReceiptSnapshot;
  const reprintNo = Number((db.prepare("SELECT COALESCE(MAX(reprint_no),0)+1 AS next FROM print_jobs WHERE transaction_id=?").get(transactionId) as { next: number }).next);
  const transaction = db.prepare("SELECT event_id FROM transactions WHERE transaction_id=?").get(transactionId) as { event_id?: string } | undefined;
  const catalogRecord = transaction?.event_id ? getCatalog(db, transaction.event_id) : undefined;
  const catalog = catalogRecord ? importEventCatalog(catalogRecord.catalogJson) : undefined;
  const snapshot: ReceiptSnapshot = { ...sourceSnapshot, isReprint: true, reprintLabel: catalog?.receiptSettings?.commonText?.reprintLabel ?? "再印刷", reprintNo, originalReceiptNumber: sourceSnapshot.publicReference };
  const artifacts = renderReceipt(db, snapshot, { templateKey: String(sourceRow.template_key), version: Number(sourceRow.template_version) });
  const assetManifest = JSON.stringify(artifacts.assets.map(({ rasterBase64: _raster, mime: _mime, ...asset }) => asset));
  if (artifacts.templateSourceSha256 !== sourceRow.template_source_sha256 || assetManifest !== sourceRow.asset_manifest_json || artifacts.rendererVersion !== sourceRow.renderer_version || artifacts.fontId !== sourceRow.font_id || artifacts.fontVersion !== sourceRow.font_version || artifacts.fontSha256 !== sourceRow.font_sha256 || artifacts.finishingPolicyId !== sourceRow.finishing_policy_id || artifacts.finishingPolicyVersion !== sourceRow.finishing_policy_version) throw new Error("SOURCE_VERSION_MISMATCH");
  const jobId = uuidV7(); const operationId = uuidV7(); const approvalId = body.approval ? uuidV7() : null; const now = new Date().toISOString(); const selfApproved = body.approval?.approverId === executorId;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (approvalId && body.approval) db.prepare("INSERT INTO print_approvals (approval_id,operation_type,subject_job_id,executor_id,approver_id,self_approved,risk_accepted,reason,approved_at,created_at) VALUES (?,'reprint',?,?,?,?,?,?,?,?)")
      .run(approvalId, body.sourcePrintJobId, executorId, body.approval.approverId, selfApproved ? 1 : 0, body.riskAccepted ? 1 : 0, body.reason.trim(), body.approval.approvedAt, now);
    db.prepare(`INSERT INTO print_jobs (job_id,operation_id,transaction_id,printer_id,document_type,kind,source_job_id,reprint_no,requested_by,reason_text,approval_id,source_physical_outcome,risk_accepted,self_approved,payload_json,created_at,state,updated_at,source,renderer_version,bytes_sha256,template_key,template_version,template_source_sha256,asset_manifest_json,font_id,font_version,font_sha256,finishing_policy_id,finishing_policy_version,receipt_snapshot_json,canonical_ir,ir_sha256,escpos_bytes,expected_bytes_length,delivery_certainty)
      VALUES (?,?,?,?,?,'reprint',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent')`)
      .run(jobId, operationId, transactionId, String(sourceRow.printer_id), "receipt", body.sourcePrintJobId, reprintNo, executorId, body.reason.trim(), approvalId, body.physicalOutcome, body.riskAccepted ? 1 : 0, selfApproved ? 1 : 0, JSON.stringify(snapshot), now, "pending", now, "event-pos", artifacts.rendererVersion, artifacts.bytesSha256, artifacts.templateKey, artifacts.templateVersion, artifacts.templateSourceSha256, assetManifest, artifacts.fontId, artifacts.fontVersion, artifacts.fontSha256, artifacts.finishingPolicyId, artifacts.finishingPolicyVersion, JSON.stringify(snapshot), artifacts.canonicalIr, artifacts.irSha256, Buffer.from(artifacts.escposBytes), artifacts.escposBytes.length);
    const sequence = Number((db.prepare("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM printer_operations").get() as { next: number }).next);
    db.prepare("INSERT INTO printer_operations (operation_id,sequence,kind,printer_id,payload_ref,state,available_at,attempt_count,max_attempts,created_at,updated_at) VALUES (?,?,'print','receipt-1',?,'pending',?,0,4,?,?)").run(operationId, sequence, jobId, now, now, now);
    db.prepare("INSERT INTO audit_log (action,entity_type,entity_id,detail_json,created_at) VALUES ('receipt_reprint','print_job',?,?,?)").run(jobId, JSON.stringify({ sourcePrintJobId: body.sourcePrintJobId, transactionId, reprintNo, executorId, approverId: body.approval?.approverId ?? null, self_approved: selfApproved, riskAccepted: body.riskAccepted, physicalOutcome: body.physicalOutcome, reason: body.reason.trim() }), now);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
  return getPrintJob(db, jobId)!;
}

export function registerPrintingRoutes(app: FastifyInstance, options: { database: PosDatabase; queue?: PersistentPrintQueue; printerStatus?: () => Promise<PrinterStatusObservation>; drawerEnabled?: boolean; authRequired?: boolean }): void {
  const editor = (request: any) => {
    requireAuthActor(options.database, request, "manager", options.authRequired ?? false);
    if (options.authRequired && options.database.prepare("SELECT 1 FROM business_sessions WHERE state='open' LIMIT 1").get()) throw new AuthError(409, "CONFIGURATION_LOCKED", "営業中はレシート設定を変更できません");
  };
  app.post<{ Body: { profile?: DrawerPulseProfile } }>("/api/v1/device-jobs/drawer", async (request, reply) => {
    if (!options.drawerEnabled) return error(reply, 409, "DRAWER_NOT_ACCEPTED", "ドロアー実機受入が完了するまで駆動できません");
    const actorId = header(request, "x-pos-actor-id"); const role = header(request, "x-pos-role");
    if (!actorId || role !== "manager") return error(reply, role ? 403 : 401, "DRAWER_MANAGER_REQUIRED", "責任者権限が必要です");
    if (!options.queue || !options.printerStatus) return error(reply, 409, "PRINTER_HOST_NOT_CONFIGURED", "プリンターとドロアーを操作するPrinterHostが設定されていません");
    const printer = await options.printerStatus().catch(() => null);
    if (!printer || printer.reachable.support !== "supported" || printer.reachable.value !== true) return error(reply, 503, "PRINTER_HOST_UNAVAILABLE", "PrinterHostへ接続できません。接続を確認してから再試行してください");
    const profile = request.body?.profile ?? "approved";
    const pulse = drawerPulseProfiles[profile];
    if (!pulse) return error(reply, 400, "DRAWER_PROFILE_INVALID", "未許可のドロアーパルスプロファイルです");
    const now = new Date().toISOString(); const jobId = uuidV7();
    try {
      const job = createPrintJob(options.database, { jobId, transactionId: `drawer-manual:${jobId}`, printerId: "receipt-1", documentType: "drawer", kind: "drawer", payload: { ...pulse, reason: profile === "approved" ? "manager_manual" : `manager_diagnostic:${profile}` }, createdAt: now, source: "event-pos", rendererVersion: "event-pos-drawer-v1", bytesSha256: pulse.bytesSha256, expectedBytesLength: 5 });
      options.database.prepare("UPDATE printer_operations SET kind='drawer' WHERE payload_ref=?").run(jobId);
      options.database.prepare("INSERT INTO audit_log (action,entity_type,entity_id,detail_json,created_at) VALUES ('drawer_open_request','printer_operation',?,?,?)").run(job.operationId ?? jobId, JSON.stringify({ actorId, profile, pin: pulse.pin, onMs: pulse.onMs, offMs: pulse.offMs }), now);
      options.queue?.trigger(); return reply.code(201).send(job);
    } catch (err) { return error(reply, 409, "DRAWER_CREATE_FAILED", err instanceof Error ? err.message : "ドロアー操作を登録できません"); }
  });
  app.get("/api/v1/receipt-templates", async (request) => { requireAuthActor(options.database, request, "manager", options.authRequired ?? false); return { templates: listReceiptTemplates(options.database) }; });
  app.post<{ Body: { templateKey: string; sourceText: string; assets?: Parameters<typeof createReceiptTemplateDraft>[1]["assets"] } }>("/api/v1/receipt-templates", async (request, reply) => {
    try { editor(request); return reply.code(201).send(createReceiptTemplateDraft(options.database, { templateKey: request.body.templateKey, sourceText: request.body.sourceText, ...(request.body.assets ? { assets: request.body.assets } : {}) })); } catch (err) { return error(reply, err instanceof AuthError ? err.status : 400, "TEMPLATE_DRAFT_INVALID", err instanceof Error ? err.message : "template draftが不正です"); }
  });
  app.post<{ Params: { templateKey: string; version: string } }>("/api/v1/receipt-templates/:templateKey/:version/validate", async (request, reply) => {
    try { editor(request); return validateReceiptTemplateVersion(options.database, request.params.templateKey, Number(request.params.version)); } catch (err) { return error(reply, err instanceof AuthError ? err.status : 422, "TEMPLATE_VALIDATION_FAILED", err instanceof Error ? err.message : "template検証に失敗しました"); }
  });
  app.post<{ Params: { templateKey: string; version: string }; Body: { snapshot?: ReceiptSnapshot } }>("/api/v1/receipt-templates/:templateKey/:version/preview", async (request, reply) => {
    try { requireAuthActor(options.database, request, "manager", options.authRequired ?? false); return previewReceiptTemplate(options.database, request.params.templateKey, Number(request.params.version), request.body?.snapshot ?? sampleReceiptSnapshot()); } catch (err) { return error(reply, err instanceof AuthError ? err.status : 422, "TEMPLATE_PREVIEW_FAILED", err instanceof Error ? err.message : "previewに失敗しました"); }
  });
  app.post<{ Params: { templateKey: string; version: string } }>("/api/v1/receipt-templates/:templateKey/:version/test-print", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired ?? false);
      const templateKey = request.params.templateKey; const version = Number(request.params.version);
      if (!getReceiptTemplate(options.database, templateKey, version)) return error(reply, 404, "TEMPLATE_NOT_FOUND", "templateが見つかりません");
      validateReceiptTemplateVersion(options.database, templateKey, version);
      const snapshot = sampleReceiptSnapshot(); const artifacts = renderReceipt(options.database, snapshot, { templateKey, version }); const jobId = uuidV7(); const now = new Date().toISOString();
      const job = createPrintJob(options.database, { jobId, transactionId: `template-test:${jobId}`, printerId: "receipt-1", documentType: "receipt", kind: "test", payload: { templateKey, templateVersion: version, snapshot, canonical_ir: artifacts.canonicalIr, escposBase64: Buffer.from(artifacts.escposBytes).toString("base64") }, createdAt: now, source: "event-pos", rendererVersion: artifacts.rendererVersion, bytesSha256: artifacts.bytesSha256, canonicalIr: artifacts.canonicalIr, irSha256: artifacts.irSha256, expectedBytesLength: artifacts.escposBytes.length, templateKey: artifacts.templateKey, templateVersion: artifacts.templateVersion, templateSourceSha256: artifacts.templateSourceSha256, assets: artifacts.assets, fontId: artifacts.fontId, fontVersion: artifacts.fontVersion, fontSha256: artifacts.fontSha256, finishingPolicyId: artifacts.finishingPolicyId, finishingPolicyVersion: artifacts.finishingPolicyVersion });
      options.queue?.trigger(); return reply.code(201).send(job);
    } catch (err) { return error(reply, err instanceof AuthError ? err.status : 422, "TEMPLATE_TEST_PRINT_FAILED", err instanceof Error ? err.message : "テスト印刷に失敗しました"); }
  });
  app.post<{ Params: { templateKey: string; version: string }; Body: { sourceSha256: string } }>("/api/v1/receipt-templates/:templateKey/:version/activate", async (request, reply) => {
    try { editor(request); return activateReceiptTemplate(options.database, request.params.templateKey, Number(request.params.version), request.body?.sourceSha256 ?? ""); } catch (err) { return error(reply, err instanceof AuthError ? err.status : 409, "TEMPLATE_ACTIVATION_REJECTED", err instanceof Error ? err.message : "有効化できません"); }
  });
  app.get<{ Params: { templateKey: string; version: string } }>("/api/v1/receipt-templates/:templateKey/:version", async (request, reply) => getReceiptTemplate(options.database, request.params.templateKey, Number(request.params.version)) ?? error(reply, 404, "TEMPLATE_NOT_FOUND", "templateが見つかりません"));

  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId/attempts", async (request, reply) => {
    if (!getPrintJob(options.database, request.params.jobId)) return error(reply, 404, "PRINT_JOB_NOT_FOUND", "印刷jobが見つかりません");
    return { attempts: options.database.prepare("SELECT attempt_no AS attemptNo,phase,started_at AS startedAt,ended_at AS endedAt,compiler_bytes_sha256 AS compilerBytesSha256,adapter_bytes_sha256 AS adapterBytesSha256,write_bytes_sha256 AS writeBytesSha256,accepted_bytes AS acceptedBytes,result,error_code AS errorCode,error_message AS errorMessage,transport_evidence_json AS transportEvidenceJson,status_snapshot_json AS statusObservationJson FROM print_attempts WHERE job_id=? ORDER BY attempt_no").all(request.params.jobId) };
  });
  app.post<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId/cancel", async (request, reply) => {
    const operation = options.database.prepare("SELECT * FROM printer_operations WHERE payload_ref=?").get(request.params.jobId) as Record<string, unknown> | undefined;
    if (!operation) return error(reply, 404, "PRINT_JOB_NOT_FOUND", "印刷jobが見つかりません");
    if (operation.state !== "pending" && operation.state !== "retry_wait") return error(reply, 409, "PRINT_JOB_NOT_CANCELABLE", "待機または再試行待ちだけ取消できます");
    const now = new Date().toISOString(); options.database.prepare("UPDATE printer_operations SET state='canceled',updated_at=? WHERE operation_id=?").run(now, String(operation.operation_id)); options.database.prepare("UPDATE print_jobs SET state='canceled',updated_at=? WHERE job_id=?").run(now, request.params.jobId);
    options.queue?.trigger();
    return getPrintJob(options.database, request.params.jobId);
  });
  app.post<{ Params: { transactionId: string }; Body: ReprintBody }>("/api/v1/transactions/:transactionId/reprints", async (request, reply) => {
    const executorId = header(request, "x-pos-actor-id"); const role = header(request, "x-pos-role");
    if (!executorId || role !== "manager") return error(reply, role ? 403 : 401, "REPRINT_MANAGER_REQUIRED", "責任者権限が必要です");
    try { const job = insertReprint(options.database, request.params.transactionId, request.body, executorId); options.queue?.trigger(); return reply.code(201).send(job); }
    catch (err) { const code = err instanceof Error ? err.message : "REPRINT_FAILED"; return error(reply, code.includes("NOT_FOUND") ? 404 : 409, code, ({ REPRINT_INPUT_REQUIRED: "再印刷の理由と実物結果が必要です", REPRINT_RISK_APPROVAL_REQUIRED: "二重印刷リスク承認と責任者承認が必要です" } as Record<string, string>)[code] ?? code); }
  });
  app.get("/api/v1/printer/status", async () => {
    const observation = options.printerStatus ? await options.printerStatus() : { observedAt: new Date().toISOString(), reachable: { support: "unknown" as const, reason: "PrinterHost未設定" }, online: { support: "unknown" as const, reason: "PrinterHost未設定" }, coverOpen: { support: "unknown" as const, reason: "PrinterHost未設定" }, drawerOpen: { support: "unknown" as const, reason: "PrinterHost未設定" }, paper: { support: "unknown" as const, reason: "PrinterHost未設定" }, error: { support: "unknown" as const, reason: "PrinterHost未設定" }, raw: null };
    return { printerId: "receipt-1", observation, queue: getPrintQueueStatus(options.database) };
  });
  app.post<{ Body: { actorId: string } }>("/api/v1/printer/resume", async (request, reply) => options.queue?.resumeDeviceFault(request.body?.actorId ?? "") ? { resumed: true } : error(reply, 409, "PRINTER_NOT_BLOCKED", "device faultで停止していません"));
}
