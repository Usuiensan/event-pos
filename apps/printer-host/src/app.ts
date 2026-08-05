import Fastify, { type FastifyInstance } from "fastify";
import type { PrinterDispatchFailure, PrinterDispatchResult, PrintJob, PrintJobState, PrintJobStateUpdate } from "@event-pos/contracts";
import { bytesSha256 } from "@event-pos/escpos";
import { renderEscPos, TransportSendError, type PrinterTransport } from "./transport.js";
import { AsyncMutex } from "./mutex.js";

export type StateSink = { update(jobId: string, update: PrintJobStateUpdate): Promise<void> };
export type PrinterHostLogEvent = Record<string, unknown> & { level: "info" | "warn" | "error"; event: string; message: string };
export type PrinterHostOptions = { transport: PrinterTransport; stateSink?: StateSink; log?: (event: PrinterHostLogEvent) => void };
type JobRecord = { job: PrintJob; result?: PrinterDispatchResult; failure?: PrinterDispatchFailure };

function sameDispatchPayload(left: PrintJob, right: PrintJob): boolean {
  // The hash and length name the immutable bytes accepted by this Host.  Do not
  // treat a reused jobId carrying different bytes as an idempotent retry.
  return left.bytesSha256 === right.bytesSha256
    && left.expectedBytesLength === right.expectedBytesLength
    && left.documentType === right.documentType
    && left.printerId === right.printerId;
}

export function buildPrinterHost(options: PrinterHostOptions): FastifyInstance {
  const app = Fastify({ logger: false }); const jobs = new Map<string, JobRecord>(); const printerMutex = new AsyncMutex();
  const log = options.log ?? (() => undefined);
  const setState = async (job: PrintJob, state: PrintJobState, errorMessage?: string): Promise<PrintJob> => {
    const updated: PrintJob = { ...job, state, updatedAt: new Date().toISOString(), ...(errorMessage ? { errorMessage } : {}) };
    const current = jobs.get(job.jobId); jobs.set(job.jobId, { job: updated, ...(current?.result ? { result: current.result } : {}), ...(current?.failure ? { failure: current.failure } : {}) });
    if (options.stateSink) await options.stateSink.update(job.jobId, { state, ...(state === "completed" ? { deliveryCertainty: "accepted", completionEvidence: "transport_accepted" } : state === "failed" ? { deliveryCertainty: "unknown" } : {}), ...(errorMessage ? { errorMessage } : {}) });
    return updated;
  };
  const reject = async (reply: { code(status: number): { send(value: unknown): unknown } }, job: PrintJob, failure: PrinterDispatchFailure): Promise<unknown> => {
    const failed = await setState(job, failure.deviceFault || (failure.retryable && failure.notSentProven) ? "retry_wait" : "failed", failure.message); jobs.set(job.jobId, { job: failed, failure });
    log({ level: failure.deviceFault ? "warn" : "error", event: "dispatch_failed", message: "印刷送信を完了できませんでした", jobId: job.jobId, bytesSha256: job.bytesSha256, acceptedBytes: failure.acceptedBytes, deliveryCertainty: failure.notSentProven && failure.acceptedBytes === 0 ? "not_sent" : "unknown", failureCode: failure.code });
    return reply.code(409).send({ failure });
  };
  app.addHook("onClose", async () => options.transport.close());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/api/v1/printer/status", async () => printerMutex.runExclusive(async () => ({ printerId: "receipt-1", observation: await options.transport.getStatus() })));
  app.get<{ Params: { jobId: string } }>("/api/v1/print-jobs/:jobId", async (request, reply) => jobs.get(request.params.jobId)?.job ?? reply.code(404).send({ error: "not_found" }));
  app.post<{ Body: PrintJob }>("/api/v1/print-jobs", async (request, reply) => {
    const input = request.body;
    if (!input?.jobId || !input.transactionId || !input.printerId || !input.documentType) return reply.code(400).send({ failure: { code: "INVALID_PRINT_JOB", message: "invalid print job", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false } });
    return printerMutex.runExclusive(async () => {
      const existing = jobs.get(input.jobId);
      if (existing) {
        if (!sameDispatchPayload(existing.job, input)) return reply.code(409).send({ failure: { code: "JOB_ID_PAYLOAD_MISMATCH", message: "同じjobIdに異なるpayload hashまたは長さは指定できません", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false } });
        if (existing.result) {
          log({ level: "info", event: "duplicate_completed", message: "同一jobIdの完了結果を再返却しました", jobId: input.jobId, bytesSha256: input.bytesSha256, acceptedBytes: existing.result.acceptedBytes });
          return reply.code(200).send({ ...existing.result, duplicate: true });
        }
        if (existing.failure) return reply.code(409).send({ failure: existing.failure, duplicate: true });
      }
      let job: PrintJob = { ...input, state: "pending", updatedAt: new Date().toISOString() }; jobs.set(job.jobId, { job });
      let bytes: Uint8Array;
      try { bytes = renderEscPos(job); } catch (error) { return reject(reply, job, { code: "RENDER_FAILED", message: error instanceof Error ? error.message : "render failed", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false }); }
      const hash = bytesSha256(bytes);
      const status = await options.transport.getStatus();
      const reachable = status.reachable.support === "supported" && status.reachable.value;
      const explicitlyOffline = status.online.support === "supported" && !status.online.value;
      const paperEmpty = status.paper.support === "supported" && status.paper.value === "empty";
      // RAW spooler may prove physical reachability without providing online,
      // cover or paper sensors. Keep those capabilities unknown, but permit one
      // dispatch attempt while no measured capability explicitly blocks it.
      const ready = reachable && !explicitlyOffline && !paperEmpty;
      if (!ready) return reject(reply, job, { code: status.paper.support === "supported" && status.paper.value === "empty" ? "PAPER_OUT" : "STATUS_UNKNOWN", message: "プリンター状態を送信可能と確認できません", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: true, statusObservation: status });
      job = await setState(job, "sending");
      log({ level: "info", event: "dispatch_started", message: "PrinterTransportへ送信を開始します", jobId: job.jobId, documentType: job.documentType, bytesSha256: hash, payloadLength: bytes.length });
      try {
        const receipt = await options.transport.send(bytes);
        if (receipt.acceptedBytes !== bytes.length) return reject(reply, job, { code: "SHORT_WRITE", message: "プリンターへのshort writeです", acceptedBytes: receipt.acceptedBytes, notSentProven: false, retryable: false, deviceFault: false });
        job = await setState(job, "completed");
        const result: PrinterDispatchResult = { jobId: job.jobId, acceptedBytes: receipt.acceptedBytes, payloadLength: bytes.length, bytesSha256: hash, completionEvidence: "transport_accepted", transportEvidence: receipt.transportEvidence, statusObservation: status, duplicate: false };
        log({ level: "info", event: "transport_accepted", message: "PrinterTransportが全bytesを受理しました。紙面完了は未確認です", jobId: job.jobId, bytesSha256: hash, acceptedBytes: receipt.acceptedBytes, payloadLength: bytes.length, transportEvidence: receipt.transportEvidence });
        jobs.set(job.jobId, { job, result }); return reply.code(201).send(result);
      } catch (error) {
        const acceptedBytes = error instanceof TransportSendError ? error.acceptedBytes : 0; const notSentProven = error instanceof TransportSendError && error.notSentProven;
        return reject(reply, job, { code: error instanceof TransportSendError ? "TRANSPORT_ERROR" : "TRANSPORT_RESULT_UNKNOWN", message: error instanceof Error ? error.message : "transport error", acceptedBytes, notSentProven, retryable: error instanceof TransportSendError && error.retryable, deviceFault: false, statusObservation: status });
      }
    });
  });
  return app;
}
