import Fastify, { type FastifyInstance } from "fastify";
import { createCashSession, createPrintJob, getCatalog, getPrintJob, getTheoreticalCash, saveCashCheck, saveCashMovement, saveCatalog, updatePrintJob, type PosDatabase } from "./db.js";
import { createCashCheck, exportEventCatalog, importEventCatalog, type CashCheckKind, type EventCatalog, type PrintJobRequest, type PrintJobState, type PrintJobStateUpdate } from "@event-pos/contracts";

const printJobStates: readonly PrintJobState[] = ["queued", "accepted", "printing", "completed", "failed", "unknown"];
const isPrintJobState = (value: unknown): value is PrintJobState => typeof value === "string" && printJobStates.includes(value as PrintJobState);

export type PrinterHost = { accept(job: ReturnType<typeof createPrintJob>): Promise<void> };
export type AppOptions = { database: PosDatabase; printerHost?: PrinterHost };

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
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
  app.post<{ Body: { sessionId: string; eventId: string; businessDate: string } }>("/api/v1/cash-sessions", async (request, reply) => {
    if (!request.body?.sessionId || !request.body.eventId || !request.body.businessDate) return reply.code(400).send({ error: "invalid_cash_session" });
    try { createCashSession(options.database, request.body.sessionId, request.body.eventId, request.body.businessDate); return reply.code(201).send({ sessionId: request.body.sessionId, state: "open" }); } catch { return reply.code(409).send({ error: "cash_session_exists" }); }
  });
  app.post<{ Params: { sessionId: string }; Body: { type: "sale" | "return" | "pay_in" | "pay_out"; amountYen: number; transactionId?: string; reason: string; idempotencyKey?: string } }>("/api/v1/cash-sessions/:sessionId/movements", async (request, reply) => {
    try {
      if (!request.body?.idempotencyKey) return reply.code(400).send({ error: "idempotency_key_required" });
      const movement = { ...request.body, sessionId: request.params.sessionId, createdAt: new Date().toISOString() };
      return reply.code(201).send(saveCashMovement(options.database, movement));
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid_cash_movement";
      return reply.code(message.includes("idempotency key") ? 409 : 400).send({ error: "invalid_cash_movement", message });
    }
  });
  app.post<{ Params: { sessionId: string; kind: string }; Body: { counted: Array<{ denomination: number; quantity: number }>; carryoverYen?: number } }>("/api/v1/cash-sessions/:sessionId/checks/:kind", async (request, reply) => {
    if (!["opening", "interim", "closing"].includes(request.params.kind)) return reply.code(400).send({ error: "invalid_cash_check_kind" });
    try {
      const input = { sessionId: request.params.sessionId, kind: request.params.kind as CashCheckKind, counted: request.body.counted as never, theoreticalYen: getTheoreticalCash(options.database, request.params.sessionId), ...(request.body.carryoverYen === undefined ? {} : { carryoverYen: request.body.carryoverYen }) };
      const check = createCashCheck(input);
      return reply.code(201).send(saveCashCheck(options.database, check));
    } catch (error) { return reply.code(400).send({ error: "invalid_cash_check", message: error instanceof Error ? error.message : "invalid_cash_check" }); }
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
    if (options.printerHost) await options.printerHost.accept(job);
    return reply.code(201).send(job);
  });
  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId", async (request, reply) => {
    const job = getPrintJob(options.database, request.params.jobId);
    return job ? job : reply.code(404).send({ error: "not_found" });
  });
  app.patch<{ Params: { jobId: string }; Body: PrintJobStateUpdate }>("/api/v1/print-jobs/:jobId/state", async (request, reply) => {
    if (!isPrintJobState(request.body?.state)) return reply.code(400).send({ error: "invalid_state" });
    const job = updatePrintJob(options.database, request.params.jobId, request.body);
    return job ? job : reply.code(404).send({ error: "not_found" });
  });
  return app;
}
