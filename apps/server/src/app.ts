import Fastify, { type FastifyInstance } from "fastify";
import { createPrintJob, getPrintJob, updatePrintJob, type PosDatabase } from "./db.js";
import { isPrintJobState, type PrintJobRequest, type PrintJobStateUpdate } from "@event-pos/contracts";

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
