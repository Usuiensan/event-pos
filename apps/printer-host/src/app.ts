import Fastify, { type FastifyInstance } from "fastify";
import type { PrintJob, PrintJobState, PrintJobStateUpdate } from "@event-pos/contracts";
import { renderEscPos, type PrinterTransport } from "./transport.js";
import { AsyncMutex } from "./mutex.js";

export type StateSink = { update(jobId: string, update: PrintJobStateUpdate): Promise<void> };
export type PrinterHostOptions = { transport: PrinterTransport; stateSink?: StateSink };

export function buildPrinterHost(options: PrinterHostOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const jobs = new Map<string, PrintJob>();
  const printerMutex = new AsyncMutex();
  const setState = async (job: PrintJob, state: PrintJobState, errorMessage?: string) => {
    const updated: PrintJob = { ...job, state, updatedAt: new Date().toISOString(), ...(errorMessage ? { errorMessage } : {}) };
    jobs.set(job.jobId, updated);
    if (options.stateSink) await options.stateSink.update(job.jobId, { state, ...(errorMessage ? { errorMessage } : {}) });
    return updated;
  };
  app.addHook("onClose", async () => options.transport.close());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId", async (request, reply) => {
    const job = jobs.get(request.params.jobId);
    return job ? job : reply.code(404).send({ error: "not_found" });
  });
  app.post<{ Body: PrintJob }>("/api/v1/print-jobs", async (request, reply) => {
    const input = request.body;
    const existing = jobs.get(input?.jobId);
    if (existing) return reply.code(200).send(existing);
    if (!input?.jobId || !input.transactionId || !input.printerId || !input.documentType) return reply.code(400).send({ error: "invalid_print_job" });
    let job: PrintJob = { ...input, state: "queued", updatedAt: new Date().toISOString() };
    jobs.set(job.jobId, job);
    job = await setState(job, "accepted");
    try {
      if (await printerMutex.runExclusive(() => options.transport.getStatus()) !== "ready") throw new Error("printer_not_ready");
      job = await setState(job, "printing");
      await printerMutex.runExclusive(() => options.transport.send(renderEscPos(job)));
      job = await setState(job, "completed");
    } catch (error) {
      job = await setState(job, "unknown", error instanceof Error ? error.message : "printer_error");
    }
    return reply.code(201).send(job);
  });
  return app;
}
