import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { createCashSession, createPrintJob, findCashJournalCandidates, findCashSessionSummary, getCashSessionSummary, getCashSettlementSummary, getCatalog, getPrintJob, getTheoreticalCash, reopenCashSession, saveCashCheck, saveCashMovement, saveReturnTransaction, saveSaleTransaction, saveCatalog, updatePrintJob, type PosDatabase } from "./db.js";
import { createCashCheck, exportEventCatalog, importEventCatalog, isPrintJobState, parsePaymentSlipCode, type CashCheckKind, type EventCatalog, type PrintJobRequest, type PrintJobStateUpdate } from "@event-pos/contracts";
import { bytesSha256, receiptDocumentToEscPos } from "@event-pos/escpos";
import { registerCheckoutRoutes } from "./checkout-routes.js";
import type { FailureInjector } from "./checkout-store.js";
import { RealtimeHub, registerRealtimeRoutes } from "./realtime.js";
import { PersistentPrintQueue, type PrinterHost } from "./print-queue.js";
import { registerPrintingRoutes } from "./printing-routes.js";
import { BackupArtifactWorker, type BackupArtifactFailureInjector } from "./backup-artifacts.js";
import { getBackupArtifact, listBackupArtifacts, reserveBackupArtifactRegeneration } from "./backup-artifact-schema.js";
import { registerOperationsDashboard } from "./operations-dashboard.js";
import { registerBusinessRoutes } from "./business-routes.js";
import { synchronizeCatalogStaff } from "./business-store.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { buildCatalog } from "@event-pos/catalog-config";
import { registerConfigManagementRoutes } from "./config-management.js";
import { registerServerFeatureRoutes } from "./server-features.js";
import { registerJournalRoutes } from "./journal.js";
import { receiptRenderOptions } from "./receipt-render-config.js";

export type { PrinterHost } from "./print-queue.js";
export type AppOptions = { database: PosDatabase; printerHost?: PrinterHost; requireCashAuth?: boolean; requireAuth?: boolean; checkoutFailureInjector?: FailureInjector; realtimeHub?: RealtimeHub; errorReportDirectory?: string; drawerEnabled?: boolean; artifactRoot?: string; artifactMinimumFreeBytes?: number; backupArtifactFailureInjector?: BackupArtifactFailureInjector; https?: { key: Buffer; cert: Buffer }; eventConfigDirectory?: string; eventConfigRepository?: string };
type EmergencyAlert = { id: string; title: string; message: string; receivedAt: string; source?: string };

function emergencyAlertFromPrintJob(body: PrintJobRequest): EmergencyAlert {
  const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
  const lines = Array.isArray(payload.lines) ? payload.lines.filter((line): line is string => typeof line === "string") : [];
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "緊急情報";
  const messageField = [payload.message, payload.body, payload.text].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  return { id: body.jobId, title, message: lines.length ? lines.join("\n") : messageField?.trim() ?? "防災情報を受信しました。詳細は印刷内容を確認してください。", receivedAt: new Date().toISOString(), ...(body.source ? { source: body.source } : {}) };
}

type CashRole = "operator" | "manager";
function cashAuth(db: PosDatabase, request: { method: string; headers: Record<string, string | string[] | undefined> }, required: CashRole, enabled: boolean): { ok: true; actorId: string } | { ok: false; status: number; error: string } {
  try { const actor = requireAuthActor(db, request, required, enabled); return { ok: true, actorId: actor.staffId }; }
  catch (error) { return error instanceof AuthError ? { ok: false, status: error.status, error: error.code } : { ok: false, status: 401, error: "AUTH_REQUIRED" }; }
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false, ...(options.https ? { https: options.https } : {}) });
  const realtimeHub = options.realtimeHub ?? new RealtimeHub();
  const printQueue = options.printerHost ? new PersistentPrintQueue(options.database, options.printerHost) : undefined;
  const backupArtifactWorker = options.artifactRoot ? new BackupArtifactWorker(options.database, options.artifactRoot, options.backupArtifactFailureInjector, options.artifactMinimumFreeBytes) : undefined;
  app.register(websocket);
  registerBusinessRoutes(app, { database: options.database, authRequired: options.requireAuth ?? options.requireCashAuth ?? false, secureCookie: !!options.https, realtimeHub });
  registerConfigManagementRoutes(app, { database: options.database, ...(options.eventConfigDirectory ? { configDirectory: options.eventConfigDirectory } : {}), ...(options.eventConfigRepository ? { configRepository: options.eventConfigRepository } : {}), authRequired: options.requireAuth ?? options.requireCashAuth ?? false });
  app.register(async (realtimeApp) => registerRealtimeRoutes(realtimeApp, options.database, realtimeHub, options.requireAuth ?? false));
  let latestEmergencyAlert: EmergencyAlert | null = null;
  app.addHook("onClose", async () => { await printQueue?.stop(); await backupArtifactWorker?.stop(); options.database.close(); });
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      options.database.prepare("SELECT 1 AS ready").get();
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: "error" });
    }
  });
  app.get("/api/v1/info", async () => ({ name: "ぽすりん", service: "server", schemaVersion: 1, drawerEnabled: options.drawerEnabled ?? false }));
  app.post<{ Body: { errorId?: string; content?: string } }>("/api/v1/error-reports", async (request, reply) => {
    const errorId = request.body?.errorId;
    const content = request.body?.content;
    if (!errorId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(errorId) || !content || content.length > 64_000) return reply.code(400).send({ error: "invalid_error_report" });
    const directory = resolve(options.errorReportDirectory ?? "./data/error-reports");
    await mkdir(directory, { recursive: true });
    try { await writeFile(join(directory, `${errorId}.txt`), content, { encoding: "utf8", flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return reply.code(201).send({ errorId });
  });
  app.post<{ Body: { code?: string; terminalId?: string } }>("/api/v1/payment-slip-reminders", async (request, reply) => {
    try { requireAuthActor(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); }
    catch (error) { return reply.code(error instanceof AuthError ? error.status : 401).send({ error: { code: error instanceof AuthError ? error.code : "AUTH_REQUIRED", message: "サインオンしてください" } }); }
    const parsed = parsePaymentSlipCode(request.body?.code ?? "");
    if (!parsed.ok) return reply.code(400).send({ error: { code: "PAYMENT_SLIP_INVALID", message: parsed.error } });
    const slip = parsed.value;
    const dueLabel = slip.dueDate.kind === "date" ? `${slip.dueDate.isoDate.slice(0, 4)}年${Number(slip.dueDate.isoDate.slice(5, 7))}月${Number(slip.dueDate.isoDate.slice(8, 10))}日` : "設定なし";
    const lines = ["払込票リマインダー", "これは領収書ではありません。", "", `支払期限：${dueLabel}`, `企業番号：${slip.gs1CompanyPrefix7}`, `請求金額：${slip.amount.toLocaleString("ja-JP")}円`];
    if (slip.dueDate.kind === "not-specified") lines.push("紙面に記載された期限を確認してください。", "カレンダー登録は行えません。");
    const document = { schemaVersion: 1 as const, contentWidthDots: 384 as const, physicalWidthDots: 416 as const, nodes: [{ kind: "reset" as const }, { kind: "align" as const, value: "center" as const }, { kind: "emphasis" as const, bold: true, underline: false, invert: false }, { kind: "text" as const, value: "払込票リマインダー" }, { kind: "emphasis" as const, bold: false, underline: false, invert: false }, { kind: "align" as const, value: "left" as const }, { kind: "rule" as const, style: "single" as const }, ...lines.slice(1).map((value) => ({ kind: "text" as const, value })), { kind: "feed" as const, lines: 5 }, { kind: "cut" as const, mode: "partial" as const }] };
    const bytes = receiptDocumentToEscPos(document, [], receiptRenderOptions()); const now = new Date().toISOString(); const jobId = `payment-slip-reminder:${randomUUID()}`;
    const job = createPrintJob(options.database, { jobId, transactionId: `payment-slip-reminder:${randomUUID()}`, printerId: request.body?.terminalId ?? "receipt-1", documentType: "payment-slip-reminder", payload: { lines, escposBase64: Buffer.from(bytes).toString("base64"), paymentSlip: { issuerCode: slip.issuerCode, dueDate: slip.dueDate, amount: slip.amount, stampFlag: slip.stampFlag } }, createdAt: now, source: "event-pos", rendererVersion: "payment-slip-reminder-v1", bytesSha256: bytesSha256(bytes), expectedBytesLength: bytes.length });
    printQueue?.trigger();
    return reply.code(201).send({ job, reminder: { dueDate: slip.dueDate, amount: slip.amount, issuerCode: slip.issuerCode, gs1CompanyPrefix7: slip.gs1CompanyPrefix7 } });
  });
  app.post<{ Body: { sessionId: string; eventId: string; businessDate: string; cashboxId?: string } }>("/api/v1/cash-sessions", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (options.requireAuth) return reply.code(410).send({ error: { code: "LEGACY_CASH_SESSION_ENDPOINT_DISABLED", message: "営業画面からレジ準備を開始してください", details: {}, requestId: request.id } });
    if (!request.body?.sessionId || !request.body.eventId || !request.body.businessDate) return reply.code(400).send({ error: "invalid_cash_session" });
    const cashboxId = request.body.cashboxId ?? "default";
    const existing = findCashSessionSummary(options.database, request.body.eventId, request.body.businessDate, cashboxId);
    if (existing) return reply.code(200).send(existing);
    try { createCashSession(options.database, request.body.sessionId, request.body.eventId, request.body.businessDate, cashboxId); return reply.code(201).send(getCashSessionSummary(options.database, request.body.sessionId)); } catch { return reply.code(409).send({ error: "cash_session_exists" }); }
  });
  app.get<{ Querystring: { eventId?: string; businessDate?: string; cashboxId?: string } }>("/api/v1/cash-sessions/current", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!request.query.eventId || !request.query.businessDate || !request.query.cashboxId) return reply.code(400).send({ error: "cash_session_scope_required" });
    return { session: findCashSessionSummary(options.database, request.query.eventId, request.query.businessDate, request.query.cashboxId) ?? null };
  });
  app.get<{ Params: { sessionId: string } }>("/api/v1/cash-sessions/:sessionId", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    return getCashSessionSummary(options.database, request.params.sessionId) ?? reply.code(404).send({ error: "cash_session_not_found" });
  });
  app.get<{ Params: { sessionId: string } }>("/api/v1/cash-sessions/:sessionId/settlement-summary", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!getCashSessionSummary(options.database, request.params.sessionId)) return reply.code(404).send({ error: "cash_session_not_found" });
    return getCashSettlementSummary(options.database, request.params.sessionId);
  });
  app.post<{ Params: { sessionId: string }; Body: { type: "sale" | "return" | "pay_in" | "pay_out"; amountYen: number; transactionId?: string; reason: string; idempotencyKey?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/movements", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      if (!request.body?.idempotencyKey) return reply.code(400).send({ error: "idempotency_key_required" });
      const movement = { ...request.body, ...(auth.actorId ? { actorId: auth.actorId } : {}), sessionId: request.params.sessionId, createdAt: new Date().toISOString() };
      saveCashMovement(options.database, movement);
      return reply.code(201).send(getCashSessionSummary(options.database, request.params.sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_cash_movement";
      return reply.code(message.includes("idempotency key") ? 409 : 400).send({ error: "invalid_cash_movement", message });
    }
  });
  app.post<{ Params: { sessionId: string }; Body: { transactionId: string; amountYen: number; idempotencyKey: string; reason?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/transactions/sale", async (request, reply) => {
    const auth = cashAuth(options.database, request, "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      const result = saveSaleTransaction(options.database, { ...request.body, sessionId: request.params.sessionId, reason: request.body.reason ?? "sale", ...(auth.actorId ? { actorId: auth.actorId } : {}) });
      return reply.code(201).send(result);
    } catch (error) { const message = error instanceof Error ? error.message : "invalid_sale"; return reply.code(message.includes("idempotency") ? 409 : 400).send({ error: "invalid_sale", message }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { transactionId: string; amountYen: number; idempotencyKey: string; reason?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/transactions/return", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      const result = saveReturnTransaction(options.database, { ...request.body, sessionId: request.params.sessionId, reason: request.body.reason ?? "return", ...(auth.actorId ? { actorId: auth.actorId } : {}) });
      return reply.code(201).send(result);
    } catch (error) { const message = error instanceof Error ? error.message : "invalid_return"; return reply.code(message.includes("idempotency") ? 409 : 400).send({ error: "invalid_return", message }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { reason: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/reopen", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try { reopenCashSession(options.database, request.params.sessionId, request.body?.reason ?? "", auth.actorId ?? request.body?.actorId, request.body?.terminalId); return getCashSessionSummary(options.database, request.params.sessionId); }
    catch (error) { return reply.code(400).send({ error: "invalid_reopen", message: error instanceof Error ? error.message : "invalid_reopen" }); }
  });
  app.post<{ Params: { sessionId: string; kind: string }; Body: { counted: Array<{ denomination: number; quantity: number }>; carryoverYen?: number; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/checks/:kind", async (request, reply) => {
    const auth = cashAuth(options.database, request, request.params.kind === "closing" ? "manager" : "operator", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!["opening", "interim", "closing"].includes(request.params.kind)) return reply.code(400).send({ error: "invalid_cash_check_kind" });
    try {
      const input = { sessionId: request.params.sessionId, kind: request.params.kind as CashCheckKind, counted: request.body.counted as never, theoreticalYen: getTheoreticalCash(options.database, request.params.sessionId), ...(request.body.carryoverYen === undefined ? {} : { carryoverYen: request.body.carryoverYen }), ...(auth.actorId ? { actorId: auth.actorId } : request.body.actorId ? { actorId: request.body.actorId } : {}), ...(request.body.terminalId ? { terminalId: request.body.terminalId } : {}) };
      const check = createCashCheck(input);
      const rawKey = request.headers["idempotency-key"]; const requestKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
      const saved = saveCashCheck(options.database, check, requestKey ? `cash-check:${requestKey}` : undefined); printQueue?.trigger(); backupArtifactWorker?.trigger();
      const cashSession = getCashSessionSummary(options.database, request.params.sessionId);
      if (cashSession) realtimeHub.notifyAll({ type: "register-state.changed", registerId: cashSession.cashboxId, businessSessionId: String((options.database.prepare("SELECT business_session_id FROM cash_sessions WHERE session_id=?").get(request.params.sessionId) as { business_session_id?: string } | undefined)?.business_session_id ?? "") });
      return reply.code(201).send(saved);
    } catch (error) {
      const message = error instanceof Error ? error.message : "現金実査を保存できません";
      if (message.includes("ACTIVE_DRAFTS_EXIST")) return reply.code(409).send({ error: { code: "ACTIVE_DRAFTS_EXIST", message: "未確定取引があるため精算できません", details: {}, requestId: request.id } });
      return reply.code(400).send({ error: { code: "INVALID_CASH_CHECK", message, details: {}, requestId: request.id } });
    }
  });
  app.get<{ Params: { sessionId: string }; Querystring: { differenceYen?: string; limit?: string; from?: string; to?: string; occurredAt?: string; actorId?: string; terminalId?: string; type?: "sale" | "return" | "pay_in" | "pay_out" } }>("/api/v1/cash-sessions/:sessionId/journal-candidates", async (request, reply) => {
    const differenceYen = Number(request.query.differenceYen);
    if (!Number.isSafeInteger(differenceYen) || differenceYen === 0) return reply.code(400).send({ error: "difference_required" });
    try {
      const candidates = findCashJournalCandidates(options.database, request.params.sessionId, { differenceYen, limit: Number(request.query.limit ?? 20), ...(request.query.from ? { from: request.query.from } : {}), ...(request.query.to ? { to: request.query.to } : {}), ...(request.query.occurredAt ? { occurredAt: request.query.occurredAt } : {}), ...(request.query.actorId ? { actorId: request.query.actorId } : {}), ...(request.query.terminalId ? { terminalId: request.query.terminalId } : {}), ...(request.query.type ? { type: request.query.type } : {}) });
      options.database.prepare("INSERT INTO audit_log (action, entity_type, entity_id, detail_json, created_at) VALUES ('journal_search', 'cash_session', ?, ?, ?)").run(request.params.sessionId, JSON.stringify(request.query), new Date().toISOString());
      return { sessionId: request.params.sessionId, differenceYen, candidates };
    } catch (error) { return reply.code(400).send({ error: "journal_search_failed", message: error instanceof Error ? error.message : "journal_search_failed" }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { candidateId: number; note?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/journal-candidates/confirm", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!Number.isSafeInteger(request.body?.candidateId)) return reply.code(400).send({ error: "candidate_id_required" });
    const now = new Date().toISOString();
    options.database.prepare("INSERT INTO audit_log (action, entity_type, entity_id, detail_json, created_at) VALUES ('journal_candidate_confirm', 'cash_movement', ?, ?, ?)").run(String(request.body.candidateId), JSON.stringify({ sessionId: request.params.sessionId, note: request.body.note ?? "", actorId: auth.actorId ?? request.body.actorId, terminalId: request.body.terminalId }), now);
    return reply.code(201).send({ confirmed: true, candidateId: request.body.candidateId });
  });
  app.get<{ Params: { eventId: string } }>("/api/v1/events/:eventId/catalog", async (request, reply) => {
    const record = getCatalog(options.database, request.params.eventId);
    if (!record) return reply.code(404).send({ error: "catalog_not_found" });
    return { catalog: importEventCatalog(record.catalogJson), updatedAt: record.updatedAt };
  });
  app.put<{ Params: { eventId: string }; Body: EventCatalog | { json: string } }>("/api/v1/events/:eventId/catalog", async (request, reply) => {
    try {
      const catalog = "json" in (request.body ?? {}) ? importEventCatalog(String((request.body as { json: string }).json)) : importEventCatalog(JSON.stringify(request.body));
      if (catalog.eventId !== request.params.eventId) return reply.code(400).send({ error: "event_id_mismatch" });
      const existingStaff = options.database.prepare("SELECT 1 FROM event_staff_assignments WHERE event_id=? LIMIT 1").get(catalog.eventId);
      if (options.requireAuth && existingStaff) requireAuthActor(options.database, request, "admin", true);
      const record = saveCatalog(options.database, catalog.eventId, exportEventCatalog(catalog));
      synchronizeCatalogStaff(options.database, catalog);
      return reply.code(200).send({ catalog, updatedAt: record.updatedAt });
    } catch (error) { return reply.code(400).send({ error: "invalid_catalog", message: error instanceof Error ? error.message : "invalid_catalog" }); }
  });
  app.post<{ Params: { eventId: string } }>("/api/v1/events/:eventId/catalog/reload", async (request, reply) => {
    if (!options.eventConfigDirectory) return reply.code(503).send({ error: "event_config_not_configured", message: "POS_EVENT_CONFIG_DIRが設定されていません" });
    try {
      const existingStaff = options.database.prepare("SELECT 1 FROM event_staff_assignments WHERE event_id=? LIMIT 1").get(request.params.eventId);
      if (options.requireAuth && existingStaff) requireAuthActor(options.database, request, "admin", true);
      if (options.database.prepare("SELECT 1 FROM business_sessions WHERE event_id=? AND state='open' LIMIT 1").get(request.params.eventId)) return reply.code(409).send({ error: "business_already_open", message: "営業開始後は設定を再読み込みできません" });
      const catalog = await buildCatalog(options.eventConfigDirectory);
      if (catalog.eventId !== request.params.eventId) return reply.code(400).send({ error: "event_id_mismatch", message: "YAMLのeventIdと対象イベントが一致しません" });
      const record = saveCatalog(options.database, catalog.eventId, exportEventCatalog(catalog), "catalog_reload");
      synchronizeCatalogStaff(options.database, catalog);
      return reply.code(200).send({ catalog, updatedAt: record.updatedAt, source: "yaml" });
    } catch (error) { return reply.code(400).send({ error: "catalog_reload_failed", message: error instanceof Error ? error.message : "YAML再読み込みに失敗しました" }); }
  });
  app.get<{ Querystring: { eventId?: string; businessDate?: string; cashboxId?: string } }>("/api/v1/backup-artifacts", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!request.query.eventId) return reply.code(400).send({ error: "event_id_required" });
    return { artifacts: listBackupArtifacts(options.database, { eventId: request.query.eventId, ...(request.query.businessDate ? { businessDate: request.query.businessDate } : {}), ...(request.query.cashboxId ? { cashboxId: request.query.cashboxId } : {}) }) };
  });
  app.get<{ Params: { artifactId: string } }>("/api/v1/backup-artifacts/:artifactId", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    return getBackupArtifact(options.database, request.params.artifactId) ?? reply.code(404).send({ error: "backup_artifact_not_found" });
  });
  app.post<{ Params: { artifactId: string } }>("/api/v1/backup-artifacts/:artifactId/regenerate", async (request, reply) => {
    const auth = cashAuth(options.database, request, "manager", options.requireAuth ?? options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    const rawKey = request.headers["idempotency-key"]; const requestKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    if (!requestKey?.trim()) return reply.code(400).send({ error: "idempotency_key_required" });
    try {
      options.database.exec("BEGIN IMMEDIATE");
      let artifact;
      try {
        const existingRequest = options.database.prepare("SELECT 1 FROM backup_artifacts WHERE request_key=?").get(`manual:${requestKey}`);
        artifact = reserveBackupArtifactRegeneration(options.database, request.params.artifactId, requestKey, auth.actorId);
        if (!existingRequest) options.database.prepare("INSERT INTO audit_log (event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'backup_artifact_regeneration_requested','backup_artifact',?,?,?)").run(artifact.eventId, artifact.artifactId, JSON.stringify({ artifactId: artifact.artifactId, retryOfArtifactId: artifact.retryOfArtifactId, triggerKind: artifact.triggerKind, requestedBy: artifact.requestedBy ?? null, result: artifact.state }), artifact.requestedAt);
        options.database.exec("COMMIT");
      } catch (error) { options.database.exec("ROLLBACK"); throw error; }
      backupArtifactWorker?.trigger();
      return reply.code(202).send(artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : "再生成要求に失敗しました";
      return reply.code(message.includes("見つかりません") ? 404 : message.includes("再生成できません") ? 409 : 400).send({ error: "backup_artifact_regeneration_failed", message });
    }
  });
  app.post<{ Body: PrintJobRequest }>("/api/v1/print-jobs", async (request, reply) => {
    const body = request.body;
    if (!body?.jobId || !body.transactionId || !body.printerId || !body.documentType || !body.createdAt) return reply.code(400).send({ error: "invalid_print_job" });
    const job = createPrintJob(options.database, body);
    if (body.documentType === "disaster-notification") latestEmergencyAlert = emergencyAlertFromPrintJob(body);
    printQueue?.trigger();
    return reply.code(201).send(job);
  });
  app.get("/api/v1/emergency-alerts/latest", async () => ({ alert: latestEmergencyAlert }));
  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId", async (request, reply) => {
    const job = getPrintJob(options.database, request.params.jobId);
    return job ? job : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { jobId: string }; Body: PrintJobStateUpdate }>("/api/v1/print-jobs/:jobId/state", async (request, reply) => {
    if (!isPrintJobState(request.body?.state)) return reply.code(400).send({ error: "invalid_state" });
    const job = updatePrintJob(options.database, request.params.jobId, request.body);
    return job ? job : reply.code(404).send({ error: "not_found" });
  });
  registerCheckoutRoutes(app, { database: options.database, authRequired: options.requireAuth ?? options.requireCashAuth ?? false, ...(printQueue ? { printQueue } : {}), ...(options.checkoutFailureInjector ? { checkoutFailureInjector: options.checkoutFailureInjector } : {}), ...(options.drawerEnabled === undefined ? {} : { drawerEnabled: options.drawerEnabled }), realtimeHub });
  registerServerFeatureRoutes(app, { database: options.database, authRequired: options.requireAuth ?? options.requireCashAuth ?? false, ...(printQueue ? { printQueue } : {}), realtimeHub });
  registerJournalRoutes(app, { database: options.database, authRequired: options.requireAuth ?? options.requireCashAuth ?? false });
  const printerStatus = options.printerHost?.getStatus ? () => options.printerHost!.getStatus!() : undefined;
  registerOperationsDashboard(app, { database: options.database, realtimeHub, ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}), ...(printerStatus ? { printerStatus } : {}) });
  registerPrintingRoutes(app, { database: options.database, authRequired: options.requireAuth ?? options.requireCashAuth ?? false, ...(printQueue ? { queue: printQueue } : {}), ...(printerStatus ? { printerStatus } : {}), ...(options.drawerEnabled === undefined ? {} : { drawerEnabled: options.drawerEnabled }) });
  printQueue?.trigger();
  backupArtifactWorker?.trigger();
  return app;
}
