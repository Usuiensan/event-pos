import Fastify, { type FastifyInstance } from "fastify";
import type { PrinterDispatchFailure, PrinterDispatchResult, PrintJob, PrintJobState, PrintJobStateUpdate } from "@event-pos/contracts";
import { bytesSha256 } from "@event-pos/escpos";
import { renderEscPos, TransportSendError, type PrinterTransport } from "./transport.js";
import { AsyncMutex } from "./mutex.js";

export type StateSink = { update(jobId: string, update: PrintJobStateUpdate): Promise<void> };
export type PrinterHostOptions = { transport: PrinterTransport; stateSink?: StateSink };
type Record = { job: PrintJob; result?: PrinterDispatchResult; failure?: PrinterDispatchFailure };

export function buildPrinterHost(options: PrinterHostOptions): FastifyInstance {
  const app = Fastify({ logger: false }); const jobs = new Map<string, Record>(); const printerMutex = new AsyncMutex();
  const setState = async (job: PrintJob, state: PrintJobState, errorMessage?: string): Promise<PrintJob> => {
    const updated: PrintJob = { ...job, state, updatedAt: new Date().toISOString(), ...(errorMessage ? { errorMessage } : {}) };
    const current = jobs.get(job.jobId); jobs.set(job.jobId, { job: updated, ...(current?.result ? { result: current.result } : {}), ...(current?.failure ? { failure: current.failure } : {}) });
    if (options.stateSink) await options.stateSink.update(job.jobId, { state, ...(state === "completed" ? { deliveryCertainty: "accepted", completionEvidence: "transport_accepted" } : state === "failed" ? { deliveryCertainty: "unknown" } : {}), ...(errorMessage ? { errorMessage } : {}) });
    return updated;
  };
  const reject = async (reply: { code(status: number): { send(value: unknown): unknown } }, job: PrintJob, failure: PrinterDispatchFailure): Promise<unknown> => {
    const failed = await setState(job, failure.deviceFault || (failure.retryable && failure.notSentProven) ? "retry_wait" : "failed", failure.message); jobs.set(job.jobId, { job: failed, failure });
    return reply.code(409).send({ failure });
  };
  app.addHook("onClose", async () => options.transport.close());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId", async (request, reply) => jobs.get(request.params.jobId)?.job ?? reply.code(404).send({ error: "not_found" }));
  app.post<{ Body: PrintJob }>("/api/v1/print-jobs", async (request, reply) => {
    const input = request.body; const existing = jobs.get(input?.jobId);
    if (existing?.result) return reply.code(200).send({ ...existing.result, duplicate: true });
    if (existing?.failure) return reply.code(409).send({ failure: existing.failure, duplicate: true });
    if (!input?.jobId || !input.transactionId || !input.printerId || !input.documentType) return reply.code(400).send({ failure: { code: "INVALID_PRINT_JOB", message: "invalid print job", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false } });
    let job: PrintJob = { ...input, state: "pending", updatedAt: new Date().toISOString() }; jobs.set(job.jobId, { job });
    let bytes: Uint8Array;
    try { bytes = renderEscPos(job); } catch (error) { return reject(reply, job, { code: "RENDER_FAILED", message: error instanceof Error ? error.message : "render failed", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false }); }
    const hash = bytesSha256(bytes);
    return printerMutex.runExclusive(async () => {
      const status = await options.transport.getStatus();
      if (status !== "ready") return reject(reply, job, { code: status === "unknown" ? "STATUS_UNKNOWN" : "DEVICE_FAULT", message: status === "unknown" ? "プリンター状態を取得できません" : `プリンター障害: ${status}`, acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: true });
      job = await setState(job, "sending");
      try {
        const receipt = await options.transport.send(bytes);
        if (receipt.acceptedBytes !== bytes.length) return reject(reply, job, { code: "SHORT_WRITE", message: "プリンターへのshort writeです", acceptedBytes: receipt.acceptedBytes, notSentProven: false, retryable: false, deviceFault: false });
        job = await setState(job, "completed");
        const result: PrinterDispatchResult = { jobId: job.jobId, acceptedBytes: receipt.acceptedBytes, payloadLength: bytes.length, bytesSha256: hash, completionEvidence: "transport_accepted", duplicate: false };
        jobs.set(job.jobId, { job, result }); return reply.code(201).send(result);
      } catch (error) {
        const acceptedBytes = error instanceof TransportSendError ? error.acceptedBytes : 0; const notSentProven = error instanceof TransportSendError && error.notSentProven;
        return reject(reply, job, { code: error instanceof TransportSendError ? "TRANSPORT_ERROR" : "TRANSPORT_RESULT_UNKNOWN", message: error instanceof Error ? error.message : "transport error", acceptedBytes, notSentProven, retryable: error instanceof TransportSendError && error.retryable, deviceFault: false });
      }
    });
  });
  return app;
}
