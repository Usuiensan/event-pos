import Fastify, { type FastifyInstance } from "fastify";
import { createCashSession, createPrintJob, findCashJournalCandidates, getCatalog, getPrintJob, getTheoreticalCash, reopenCashSession, saveCashCheck, saveCashMovement, saveReturnTransaction, saveSaleTransaction, saveCatalog, updatePrintJob, type PosDatabase } from "./db.js";
import { createCashCheck, exportEventCatalog, importEventCatalog, type CashCheckKind, type EventCatalog, type PrintJobRequest, type PrintJobState, type PrintJobStateUpdate } from "@event-pos/contracts";
import { registerCheckoutRoutes } from "./checkout-routes.js";
import type { FailureInjector } from "./checkout-store.js";

const printJobStates: readonly PrintJobState[] = ["queued", "accepted", "printing", "completed", "failed", "unknown"];
const isPrintJobState = (value: unknown): value is PrintJobState => typeof value === "string" && printJobStates.includes(value as PrintJobState);

export type PrinterHost = { accept(job: ReturnType<typeof createPrintJob>): Promise<void> };
export type AppOptions = { database: PosDatabase; printerHost?: PrinterHost; requireCashAuth?: boolean; checkoutFailureInjector?: FailureInjector };
type EmergencyAlert = { id: string; title: string; message: string; receivedAt: string; source?: string };

function emergencyAlertFromPrintJob(body: PrintJobRequest): EmergencyAlert {
  const payload = body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {};
  const lines = Array.isArray(payload.lines) ? payload.lines.filter((line): line is string => typeof line === "string") : [];
  const title = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : "緊急情報";
  const messageField = [payload.message, payload.body, payload.text].find((value) => typeof value === "string" && value.trim()) as string | undefined;
  return { id: body.jobId, title, message: lines.length ? lines.join("\n") : messageField?.trim() ?? "防災情報を受信しました。詳細は印刷内容を確認してください。", receivedAt: new Date().toISOString(), ...(body.source ? { source: body.source } : {}) };
}

type CashRole = "operator" | "manager";
function cashAuth(request: { headers: Record<string, string | string[] | undefined> }, required: CashRole, enabled: boolean): { ok: true; actorId?: string } | { ok: false; status: number; error: string } {
  if (!enabled) return { ok: true };
  const role = request.headers["x-pos-role"];
  const actorId = request.headers["x-pos-actor-id"];
  const value = Array.isArray(role) ? role[0] : role;
  const actor = Array.isArray(actorId) ? actorId[0] : actorId;
  if (!actor || (value !== "operator" && value !== "manager")) return { ok: false, status: 401, error: "cash_auth_required" };
  if (required === "manager" && value !== "manager") return { ok: false, status: 403, error: "cash_manager_required" };
  return { ok: true, actorId: actor };
}

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  let latestEmergencyAlert: EmergencyAlert | null = null;
  app.addHook("onClose", async () => options.database.close());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      options.database.prepare("SELECT 1 AS ready").get();
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: "error" });
    }
  });
  app.get("/api/v1/info", async () => ({ name: "event-pos", service: "server", schemaVersion: 1 }));
  app.post<{ Body: { sessionId: string; eventId: string; businessDate: string; cashboxId?: string } }>("/api/v1/cash-sessions", async (request, reply) => {
    const auth = cashAuth(request, "operator", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!request.body?.sessionId || !request.body.eventId || !request.body.businessDate) return reply.code(400).send({ error: "invalid_cash_session" });
    try { createCashSession(options.database, request.body.sessionId, request.body.eventId, request.body.businessDate, request.body.cashboxId); return reply.code(201).send({ sessionId: request.body.sessionId, cashboxId: request.body.cashboxId ?? "default", state: "open" }); } catch { return reply.code(409).send({ error: "cash_session_exists" }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { type: "sale" | "return" | "pay_in" | "pay_out"; amountYen: number; transactionId?: string; reason: string; idempotencyKey?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/movements", async (request, reply) => {
    const auth = cashAuth(request, "operator", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      if (!request.body?.idempotencyKey) return reply.code(400).send({ error: "idempotency_key_required" });
      const movement = { ...request.body, ...(auth.actorId ? { actorId: auth.actorId } : {}), sessionId: request.params.sessionId, createdAt: new Date().toISOString() };
      return reply.code(201).send(saveCashMovement(options.database, movement));
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_cash_movement";
      return reply.code(message.includes("idempotency key") ? 409 : 400).send({ error: "invalid_cash_movement", message });
    }
  });
  app.post<{ Params: { sessionId: string }; Body: { transactionId: string; amountYen: number; idempotencyKey: string; reason?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/transactions/sale", async (request, reply) => {
    const auth = cashAuth(request, "operator", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      const result = saveSaleTransaction(options.database, { ...request.body, sessionId: request.params.sessionId, reason: request.body.reason ?? "sale", ...(auth.actorId ? { actorId: auth.actorId } : {}) });
      return reply.code(201).send(result);
    } catch (error) { const message = error instanceof Error ? error.message : "invalid_sale"; return reply.code(message.includes("idempotency") ? 409 : 400).send({ error: "invalid_sale", message }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { transactionId: string; amountYen: number; idempotencyKey: string; reason?: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/transactions/return", async (request, reply) => {
    const auth = cashAuth(request, "manager", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try {
      const result = saveReturnTransaction(options.database, { ...request.body, sessionId: request.params.sessionId, reason: request.body.reason ?? "return", ...(auth.actorId ? { actorId: auth.actorId } : {}) });
      return reply.code(201).send(result);
    } catch (error) { const message = error instanceof Error ? error.message : "invalid_return"; return reply.code(message.includes("idempotency") ? 409 : 400).send({ error: "invalid_return", message }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { reason: string; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/reopen", async (request, reply) => {
    const auth = cashAuth(request, "manager", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    try { reopenCashSession(options.database, request.params.sessionId, request.body?.reason ?? "", auth.actorId ?? request.body?.actorId, request.body?.terminalId); return { sessionId: request.params.sessionId, state: "open" }; }
    catch (error) { return reply.code(400).send({ error: "invalid_reopen", message: error instanceof Error ? error.message : "invalid_reopen" }); }
  });
  app.post<{ Params: { sessionId: string; kind: string }; Body: { counted: Array<{ denomination: number; quantity: number }>; carryoverYen?: number; actorId?: string; terminalId?: string } }>("/api/v1/cash-sessions/:sessionId/checks/:kind", async (request, reply) => {
    const auth = cashAuth(request, request.params.kind === "closing" ? "manager" : "operator", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
    if (!["opening", "interim", "closing"].includes(request.params.kind)) return reply.code(400).send({ error: "invalid_cash_check_kind" });
    try {
      const input = { sessionId: request.params.sessionId, kind: request.params.kind as CashCheckKind, counted: request.body.counted as never, theoreticalYen: getTheoreticalCash(options.database, request.params.sessionId), ...(request.body.carryoverYen === undefined ? {} : { carryoverYen: request.body.carryoverYen }), ...(auth.actorId ? { actorId: auth.actorId } : request.body.actorId ? { actorId: request.body.actorId } : {}), ...(request.body.terminalId ? { terminalId: request.body.terminalId } : {}) };
      const check = createCashCheck(input);
      return reply.code(201).send(saveCashCheck(options.database, check));
    } catch (error) { return reply.code(400).send({ error: "invalid_cash_check", message: error instanceof Error ? error.message : "invalid_cash_check" }); }
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
    const auth = cashAuth(request, "manager", options.requireCashAuth ?? false); if (!auth.ok) return reply.code(auth.status).send({ error: auth.error });
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
      const record = saveCatalog(options.database, catalog.eventId, exportEventCatalog(catalog));
      return reply.code(200).send({ catalog, updatedAt: record.updatedAt });
    } catch (error) { return reply.code(400).send({ error: "invalid_catalog", message: error instanceof Error ? error.message : "invalid_catalog" }); }
  });
  app.post<{ Body: PrintJobRequest }>("/api/v1/print-jobs", async (request, reply) => {
    const body = request.body;
    if (!body?.jobId || !body.transactionId || !body.printerId || !body.documentType || !body.createdAt) return reply.code(400).send({ error: "invalid_print_job" });
    const job = createPrintJob(options.database, body);
    if (body.documentType === "disaster-notification") latestEmergencyAlert = emergencyAlertFromPrintJob(body);
    if (options.printerHost) await options.printerHost.accept(job);
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
  registerCheckoutRoutes(app, options);
  return app;
}
