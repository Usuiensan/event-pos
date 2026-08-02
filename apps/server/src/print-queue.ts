import type { PrinterDispatchFailure, PrinterDispatchResult, PrinterStatusObservation, PrintJob } from "@event-pos/contracts";
import { bytesSha256 } from "@event-pos/escpos";
import { uuidV7 } from "./checkout-store.js";
import { getPrintJob, type PosDatabase } from "./db.js";

export type PrinterHost = { accept(job: PrintJob): Promise<PrinterDispatchResult>; getStatus?(): Promise<PrinterStatusObservation> };

export class PrinterHostFailure extends Error {
  constructor(public readonly failure: PrinterDispatchFailure) { super(failure.message); }
}

export type QueueRunResult = "idle" | "blocked" | "processed";
type Clock = () => Date;

function transaction(db: PosDatabase, work: () => void): void {
  db.exec("BEGIN IMMEDIATE");
  try { work(); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function headOperation(db: PosDatabase): Record<string, unknown> | undefined {
  return db.prepare("SELECT * FROM printer_operations WHERE printer_id='receipt-1' AND state IN ('pending','sending','retry_wait') ORDER BY sequence LIMIT 1").get() as Record<string, unknown> | undefined;
}

function updateAttempt(db: PosDatabase, jobId: string, attemptNo: number, values: { phase?: string; endedAt?: string; adapterHash?: string; writeHash?: string; acceptedBytes?: number; result?: string; errorCode?: string; errorMessage?: string; transportEvidence?: unknown; statusObservation?: unknown }): void {
  db.prepare(`UPDATE print_attempts SET phase=COALESCE(?,phase),ended_at=COALESCE(?,ended_at),adapter_bytes_sha256=COALESCE(?,adapter_bytes_sha256),write_bytes_sha256=COALESCE(?,write_bytes_sha256),accepted_bytes=COALESCE(?,accepted_bytes),result=COALESCE(?,result),error_code=COALESCE(?,error_code),error_message=COALESCE(?,error_message),transport_evidence_json=COALESCE(?,transport_evidence_json),status_snapshot_json=COALESCE(?,status_snapshot_json) WHERE job_id=? AND attempt_no=?`)
    .run(values.phase ?? null, values.endedAt ?? null, values.adapterHash ?? null, values.writeHash ?? null, values.acceptedBytes ?? null, values.result ?? null, values.errorCode ?? null, values.errorMessage ?? null, values.transportEvidence === undefined ? null : JSON.stringify(values.transportEvidence), values.statusObservation === undefined ? null : JSON.stringify(values.statusObservation), jobId, attemptNo);
}

export function recoverInterruptedPrintAttempts(db: PosDatabase, now = new Date().toISOString()): void {
  const rows = db.prepare(`SELECT o.operation_id,o.payload_ref,a.attempt_no,a.phase FROM printer_operations o LEFT JOIN print_attempts a ON a.job_id=o.payload_ref AND a.attempt_no=(SELECT MAX(x.attempt_no) FROM print_attempts x WHERE x.job_id=o.payload_ref) WHERE o.state='sending'`).all() as Array<Record<string, unknown>>;
  transaction(db, () => {
    for (const row of rows) {
      const safe = row.phase === "prepared" || row.phase === null;
      if (safe) {
        db.prepare("UPDATE printer_operations SET state='pending',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=?").run(now, String(row.operation_id));
        db.prepare("UPDATE print_jobs SET state='pending',delivery_certainty='not_sent',updated_at=?,error_message=NULL WHERE job_id=?").run(now, String(row.payload_ref));
        if (row.attempt_no) updateAttempt(db, String(row.payload_ref), Number(row.attempt_no), { endedAt: now, result: "recovered_before_dispatch" });
      } else {
        db.prepare("UPDATE printer_operations SET state='failed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE operation_id=?").run(now, String(row.operation_id));
        db.prepare("UPDATE print_jobs SET state='failed',delivery_certainty='unknown',updated_at=?,error_message='dispatch_started後にprocessが終了しました' WHERE job_id=?").run(now, String(row.payload_ref));
        if (row.attempt_no) updateAttempt(db, String(row.payload_ref), Number(row.attempt_no), { endedAt: now, result: "unknown", errorCode: "PROCESS_CRASH_AFTER_DISPATCH", errorMessage: "dispatch_started後にprocessが終了しました" });
      }
    }
  });
}

export class PersistentPrintQueue {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(private readonly db: PosDatabase, private readonly host: PrinterHost, private readonly clock: Clock = () => new Date()) {
    recoverInterruptedPrintAttempts(db, clock().toISOString());
  }

  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }

  trigger(): void {
    if (this.stopped || this.running) return;
    this.running = this.drain().catch(() => undefined).finally(() => { this.running = undefined; });
  }

  async waitForIdle(): Promise<void> { await this.running; }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const result = await this.runOnce();
      if (result !== "processed") return;
    }
  }

  private schedule(at: string): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, Date.parse(at) - this.clock().getTime());
    this.timer = setTimeout(() => { this.timer = undefined; this.trigger(); }, delay);
    this.timer.unref?.();
  }

  async runOnce(): Promise<QueueRunResult> {
    const operation = headOperation(this.db); if (!operation) return "idle";
    if (operation.state === "sending") return "blocked";
    if (operation.block_reason === "device_fault") return "blocked";
    const now = this.clock();
    if (operation.state === "retry_wait" && Date.parse(String(operation.available_at)) > now.getTime()) { this.schedule(String(operation.available_at)); return "blocked"; }
    const job = getPrintJob(this.db, String(operation.payload_ref)); if (!job) throw new Error("print jobが見つかりません");
    const row = this.db.prepare("SELECT escpos_bytes,bytes_sha256,expected_bytes_length FROM print_jobs WHERE job_id=?").get(job.jobId) as { escpos_bytes: Uint8Array | null; bytes_sha256: string | null; expected_bytes_length: number | null };
    let compilerHash = row.bytes_sha256 ?? job.bytesSha256; let payloadLength = row.expected_bytes_length ?? job.expectedBytesLength;
    if (row.escpos_bytes) {
      const storedHash = bytesSha256(row.escpos_bytes);
      if (storedHash !== compilerHash || row.escpos_bytes.length !== payloadLength) return this.failBeforeSend(operation, job, "COMPILER_HASH_MISMATCH", "compiler出力hashが一致しません");
    }
    if (!compilerHash || !Number.isSafeInteger(payloadLength) || payloadLength! < 1) {
      const raw = job.payload as { escposBase64?: unknown };
      if (typeof raw?.escposBase64 !== "string") return this.failBeforeSend(operation, job, "PRINT_PAYLOAD_INVALID", "印刷payloadが不正です");
      const bytes = Uint8Array.from(Buffer.from(raw.escposBase64, "base64")); compilerHash = bytesSha256(bytes); payloadLength = bytes.length;
      this.db.prepare("UPDATE print_jobs SET bytes_sha256=?,expected_bytes_length=? WHERE job_id=?").run(compilerHash, payloadLength, job.jobId);
      job.bytesSha256 = compilerHash; job.expectedBytesLength = payloadLength;
    }
    const attemptNo = Number(operation.attempt_count) + 1; const startedAt = now.toISOString();
    transaction(this.db, () => {
      this.db.prepare("INSERT INTO print_attempts (attempt_id,job_id,attempt_no,phase,started_at,compiler_bytes_sha256) VALUES (?,?,?,'prepared',?,?)").run(uuidV7(), job.jobId, attemptNo, startedAt, compilerHash);
      this.db.prepare("UPDATE printer_operations SET state='sending',attempt_count=?,block_reason=NULL,updated_at=? WHERE operation_id=?").run(attemptNo, startedAt, String(operation.operation_id));
      this.db.prepare("UPDATE print_jobs SET state='sending',delivery_certainty='not_sent',updated_at=?,error_message=NULL WHERE job_id=?").run(startedAt, job.jobId);
    });
    transaction(this.db, () => {
      updateAttempt(this.db, job.jobId, attemptNo, { phase: "dispatch_started", adapterHash: compilerHash, writeHash: compilerHash });
    });
    try {
      const result = await this.host.accept({ ...job, state: "sending", updatedAt: startedAt });
      if (result.bytesSha256 !== compilerHash || result.payloadLength !== payloadLength || result.acceptedBytes !== payloadLength) {
        return this.finishFailure(operation, job, attemptNo, { code: "SHORT_WRITE_OR_HASH_MISMATCH", message: "acceptedBytesまたはbytes hashが一致しません", acceptedBytes: result.acceptedBytes, notSentProven: false, retryable: false, deviceFault: false });
      }
      transaction(this.db, () => {
        updateAttempt(this.db, job.jobId, attemptNo, { phase: "transport_accepted", acceptedBytes: result.acceptedBytes, result: "transport_accepted", transportEvidence: result.transportEvidence, statusObservation: result.statusObservation });
      });
      const endedAt = this.clock().toISOString();
      transaction(this.db, () => {
        updateAttempt(this.db, job.jobId, attemptNo, { phase: "postcheck_completed", endedAt, acceptedBytes: result.acceptedBytes, result: "completed" });
        this.db.prepare("UPDATE printer_operations SET state='completed',updated_at=? WHERE operation_id=?").run(endedAt, String(operation.operation_id));
        this.db.prepare("UPDATE print_jobs SET state='completed',delivery_certainty='accepted',completion_evidence=?,updated_at=?,error_message=NULL WHERE job_id=?").run(result.completionEvidence, endedAt, job.jobId);
      });
      return "processed";
    } catch (error) {
      const failure = error instanceof PrinterHostFailure ? error.failure : { code: "PRINTER_HOST_RESULT_UNKNOWN", message: error instanceof Error ? error.message : "PrinterHost応答が不明です", acceptedBytes: 0, notSentProven: false, retryable: false, deviceFault: false };
      return this.finishFailure(operation, job, attemptNo, failure);
    }
  }

  private failBeforeSend(operation: Record<string, unknown>, job: PrintJob, code: string, message: string): QueueRunResult {
    const now = this.clock().toISOString();
    transaction(this.db, () => {
      this.db.prepare("UPDATE printer_operations SET state='failed',updated_at=? WHERE operation_id=?").run(now, String(operation.operation_id));
      this.db.prepare("UPDATE print_jobs SET state='failed',delivery_certainty='not_sent',updated_at=?,error_message=? WHERE job_id=?").run(now, message, job.jobId);
    });
    return "processed";
  }

  private finishFailure(operation: Record<string, unknown>, job: PrintJob, attemptNo: number, failure: PrinterDispatchFailure): QueueRunResult {
    const now = this.clock(); const endedAt = now.toISOString(); const maxAttempts = Number(operation.max_attempts ?? 4);
    const safeRetry = failure.retryable && failure.notSentProven && failure.acceptedBytes === 0 && !failure.deviceFault && attemptNo < maxAttempts;
    // A physical fault is not a transient retry budget.  Keep the FIFO head
    // blocked until an observation or an accountable manager resumes it.
    const deviceBlock = failure.deviceFault && failure.notSentProven && failure.acceptedBytes === 0;
    const backoff = [2, 5, 15][attemptNo - 1] ?? 15; const availableAt = new Date(now.getTime() + backoff * 1000).toISOString();
    transaction(this.db, () => {
      updateAttempt(this.db, job.jobId, attemptNo, { endedAt, acceptedBytes: failure.acceptedBytes, result: deviceBlock ? "device_fault" : safeRetry ? "retry_wait" : failure.notSentProven ? "failed" : "unknown", errorCode: failure.code, errorMessage: failure.message, transportEvidence: failure.transportEvidence, statusObservation: failure.statusObservation });
      if (deviceBlock) {
        this.db.prepare("UPDATE printer_operations SET state='retry_wait',block_reason='device_fault',available_at=?,updated_at=? WHERE operation_id=?").run(endedAt, endedAt, String(operation.operation_id));
        this.db.prepare("UPDATE print_jobs SET state='retry_wait',delivery_certainty='not_sent',updated_at=?,error_message=? WHERE job_id=?").run(endedAt, failure.message, job.jobId);
      } else if (safeRetry) {
        this.db.prepare("UPDATE printer_operations SET state='retry_wait',available_at=?,updated_at=? WHERE operation_id=?").run(availableAt, endedAt, String(operation.operation_id));
        this.db.prepare("UPDATE print_jobs SET state='retry_wait',delivery_certainty='not_sent',updated_at=?,error_message=? WHERE job_id=?").run(endedAt, failure.message, job.jobId);
      } else {
        const certainty = failure.notSentProven && failure.acceptedBytes === 0 ? "not_sent" : "unknown";
        this.db.prepare("UPDATE printer_operations SET state='failed',updated_at=? WHERE operation_id=?").run(endedAt, String(operation.operation_id));
        this.db.prepare("UPDATE print_jobs SET state='failed',delivery_certainty=?,updated_at=?,error_message=? WHERE job_id=?").run(certainty, endedAt, failure.message, job.jobId);
      }
    });
    if (safeRetry) this.schedule(availableAt);
    return "processed";
  }

  resumeDeviceFault(actorId: string): boolean {
    if (!actorId.trim()) throw new Error("責任者IDが必要です");
    const operation = headOperation(this.db); if (!operation || operation.block_reason !== "device_fault") return false;
    const now = this.clock().toISOString(); transaction(this.db, () => {
      this.db.prepare("UPDATE printer_operations SET state='pending',block_reason=NULL,available_at=?,updated_at=? WHERE operation_id=?").run(now, now, String(operation.operation_id));
      this.db.prepare("UPDATE print_jobs SET state='pending',updated_at=?,error_message=NULL WHERE job_id=?").run(now, String(operation.payload_ref));
      this.db.prepare("INSERT INTO audit_log (action,entity_type,entity_id,detail_json,created_at) VALUES ('printer_resume','printer_operation',?,?,?)").run(String(operation.operation_id), JSON.stringify({ actorId }), now);
    }); this.trigger(); return true;
  }
}
