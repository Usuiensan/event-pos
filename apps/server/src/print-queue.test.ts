import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesSha256 } from "@event-pos/escpos";
import type { PrinterDispatchFailure, PrinterDispatchResult, PrintJob } from "@event-pos/contracts";
import { buildPrinterHost } from "@event-pos/printer-host/app";
import { FakeTransport, TransportSendError } from "@event-pos/printer-host/transport";
import { createPrintJob, getPrintJob, openDatabase, type PosDatabase } from "./db.js";
import { PersistentPrintQueue, PrinterHostFailure } from "./print-queue.js";

const databases: PosDatabase[] = [];
const queues: PersistentPrintQueue[] = [];

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.stop();
  for (const database of databases.splice(0)) database.close();
});

function database(): PosDatabase {
  const value = openDatabase();
  databases.push(value);
  return value;
}

function enqueueRaw(db: PosDatabase, jobId: string): PrintJob {
  const bytes = Uint8Array.from(Buffer.from(`payload:${jobId}`));
  return createPrintJob(db, {
    jobId,
    transactionId: `tx:${jobId}`,
    printerId: "register-1",
    documentType: "disaster-notification",
    payload: { escposBase64: Buffer.from(bytes).toString("base64") },
    createdAt: "2026-08-02T00:00:00.000Z",
    source: "test",
    rendererVersion: "test-renderer-v1",
    bytesSha256: bytesSha256(bytes),
    expectedBytesLength: bytes.length,
  });
}

function accepted(job: PrintJob): PrinterDispatchResult {
  return {
    jobId: job.jobId,
    acceptedBytes: job.expectedBytesLength!,
    payloadLength: job.expectedBytesLength!,
    bytesSha256: job.bytesSha256!,
    completionEvidence: "transport_accepted",
    duplicate: false,
  };
}

function failure(overrides: Partial<PrinterDispatchFailure> = {}): PrinterHostFailure {
  return new PrinterHostFailure({ code: "USB_NOT_SENT", message: "送信前に失敗", acceptedBytes: 0, notSentProven: true, retryable: true, deviceFault: false, ...overrides });
}

describe("persistent print queue", () => {
  it("4件を同時通知してもsequence順に1件ずつ送信し、bytesを混在させない", async () => {
    const db = database();
    for (const id of ["job-1", "job-2", "job-3", "job-4"]) enqueueRaw(db, id);
    const active: string[] = [];
    const order: string[] = [];
    const host = { accept: async (job: PrintJob) => {
      active.push(job.jobId);
      expect(active).toHaveLength(1);
      await Promise.resolve();
      order.push(job.jobId);
      active.pop();
      return accepted(job);
    } };
    const queue = new PersistentPrintQueue(db, host); queues.push(queue);
    queue.trigger(); queue.trigger(); queue.trigger(); queue.trigger();
    await queue.waitForIdle();

    expect(order).toEqual(["job-1", "job-2", "job-3", "job-4"]);
    expect(db.prepare("SELECT payload_ref,state FROM printer_operations ORDER BY sequence").all()).toEqual([
      { payload_ref: "job-1", state: "completed" },
      { payload_ref: "job-2", state: "completed" },
      { payload_ref: "job-3", state: "completed" },
      { payload_ref: "job-4", state: "completed" },
    ]);
    const attempts = db.prepare("SELECT phase,compiler_bytes_sha256 AS compilerHash,adapter_bytes_sha256 AS adapterHash,write_bytes_sha256 AS writeHash,accepted_bytes AS acceptedBytes FROM print_attempts ORDER BY job_id").all() as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(4);
    for (const attempt of attempts) {
      expect(attempt.phase).toBe("postcheck_completed");
      expect(attempt.adapterHash).toBe(attempt.compilerHash);
      expect(attempt.writeHash).toBe(attempt.compilerHash);
      expect(Number(attempt.acceptedBytes)).toBeGreaterThan(0);
    }
  });

  it("0 byte確定失敗だけを2/5/15秒後に最大4回再試行し、headが後続を止める", async () => {
    const db = database();
    enqueueRaw(db, "head"); enqueueRaw(db, "tail");
    let nowMs = Date.parse("2026-08-02T00:00:00.000Z");
    const calls: string[] = [];
    const host = { accept: async (job: PrintJob) => {
      calls.push(job.jobId);
      if (job.jobId === "head") throw failure();
      return accepted(job);
    } };
    const queue = new PersistentPrintQueue(db, host, () => new Date(nowMs)); queues.push(queue);

    expect(await queue.runOnce()).toBe("processed");
    expect(await queue.runOnce()).toBe("blocked");
    expect(calls).toEqual(["head"]);
    expect(db.prepare("SELECT available_at FROM printer_operations WHERE payload_ref='head'").get()).toEqual({ available_at: "2026-08-02T00:00:02.000Z" });

    nowMs += 2_000; expect(await queue.runOnce()).toBe("processed");
    expect(db.prepare("SELECT available_at FROM printer_operations WHERE payload_ref='head'").get()).toEqual({ available_at: "2026-08-02T00:00:07.000Z" });
    nowMs += 5_000; expect(await queue.runOnce()).toBe("processed");
    expect(db.prepare("SELECT available_at FROM printer_operations WHERE payload_ref='head'").get()).toEqual({ available_at: "2026-08-02T00:00:22.000Z" });
    nowMs += 15_000; expect(await queue.runOnce()).toBe("processed");
    expect(getPrintJob(db, "head")).toMatchObject({ state: "failed", deliveryCertainty: "not_sent" });
    expect(await queue.runOnce()).toBe("processed");
    expect(calls).toEqual(["head", "head", "head", "head", "tail"]);
    expect(db.prepare("SELECT attempt_no,result FROM print_attempts WHERE job_id='head' ORDER BY attempt_no").all()).toEqual([
      { attempt_no: 1, result: "retry_wait" }, { attempt_no: 2, result: "retry_wait" }, { attempt_no: 3, result: "retry_wait" }, { attempt_no: 4, result: "failed" },
    ]);
  });

  it("デバイスを開けるようになったら先頭を一度だけ送信してから後続へ進む", async () => {
    const db = database();
    enqueueRaw(db, "head"); enqueueRaw(db, "tail");
    const transport = new FakeTransport();
    vi.spyOn(transport, "send").mockRejectedValueOnce(new TransportSendError("デバイスを開けません", 0, true));
    const getStatus = vi.spyOn(transport, "getStatus");
    const app = buildPrinterHost({ transport, statusPollIntervalMs: 60_000 });
    let nowMs = Date.parse("2026-08-02T00:00:00.000Z");
    const queue = new PersistentPrintQueue(db, { accept: async (job) => {
      const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
      if (response.statusCode === 409) throw new PrinterHostFailure(response.json().failure);
      expect(response.statusCode).toBe(201);
      return response.json<PrinterDispatchResult>();
    } }, () => new Date(nowMs));
    try {
      expect(await queue.runOnce()).toBe("processed");
      expect(getPrintJob(db, "head")).toMatchObject({ state: "retry_wait", deliveryCertainty: "not_sent" });
      expect(await queue.runOnce()).toBe("blocked");
      expect(getPrintJob(db, "tail")?.state).toBe("pending");
      expect(transport.sent).toHaveLength(0);

      const statusReadsBeforeRetry = getStatus.mock.calls.length;
      nowMs += 2_000;
      expect(await queue.runOnce()).toBe("processed");
      expect(getPrintJob(db, "head")).toMatchObject({ state: "completed", deliveryCertainty: "accepted" });
      expect(getStatus).toHaveBeenCalledTimes(statusReadsBeforeRetry + 1);
      expect(transport.sent.map((bytes) => Buffer.from(bytes).toString())).toEqual(["payload:head"]);

      expect(await queue.runOnce()).toBe("processed");
      expect(getPrintJob(db, "tail")).toMatchObject({ state: "completed", deliveryCertainty: "accepted" });
      expect(await queue.runOnce()).toBe("idle");
      expect(transport.sent.map((bytes) => Buffer.from(bytes).toString())).toEqual(["payload:head", "payload:tail"]);
    } finally {
      await queue.stop();
      await app.close();
    }
  });

  it("short write・timeout・host crashはunknownとして失敗し、自動再送しない", async () => {
    for (const [jobId, thrown] of [
      ["short", failure({ code: "SHORT_WRITE", acceptedBytes: 3, notSentProven: false })],
      ["timeout", failure({ code: "TIMEOUT", acceptedBytes: 0, notSentProven: false })],
      ["crash", new Error("connection reset")],
    ] as const) {
      const db = database(); enqueueRaw(db, jobId);
      let calls = 0;
      const queue = new PersistentPrintQueue(db, { accept: async () => { calls += 1; throw thrown; } }); queues.push(queue);
      expect(await queue.runOnce()).toBe("processed");
      expect(await queue.runOnce()).toBe("idle");
      expect(calls).toBe(1);
      expect(getPrintJob(db, jobId)).toMatchObject({ state: "failed", deliveryCertainty: "unknown" });
    }
  });

  it("device faultでheadを止め、責任者の再開操作後に同じjobを送る", async () => {
    const db = database(); enqueueRaw(db, "paper-out"); enqueueRaw(db, "later");
    let first = true; const order: string[] = [];
    const queue = new PersistentPrintQueue(db, { accept: async (job) => {
      if (first) { first = false; throw failure({ code: "PAPER_OUT", message: "用紙切れ", deviceFault: true }); }
      order.push(job.jobId); return accepted(job);
    } }); queues.push(queue);
    expect(await queue.runOnce()).toBe("processed");
    expect(await queue.runOnce()).toBe("blocked");
    expect(queue.resumeDeviceFault("manager-1")).toBe(true);
    await queue.waitForIdle();
    expect(order).toEqual(["paper-out", "later"]);
    expect(db.prepare("SELECT action,detail_json FROM audit_log WHERE action='printer_resume'").get()).toMatchObject({ action: "printer_resume" });
  });

  it("device faultは4回目以降もFIFO headを解除せず、責任者resumeまで待機する", async () => {
    const db = database(); enqueueRaw(db, "blocked"); enqueueRaw(db, "later");
    const queue = new PersistentPrintQueue(db, { accept: async () => { throw failure({ code: "PAPER_OUT", deviceFault: true }); } }); queues.push(queue);
    expect(await queue.runOnce()).toBe("processed");
    expect(await queue.runOnce()).toBe("blocked");
    for (let index = 0; index < 3; index += 1) {
      expect(queue.resumeDeviceFault("manager-1")).toBe(true);
      await queue.waitForIdle();
      expect(await queue.runOnce()).toBe("blocked");
    }
    expect(getPrintJob(db, "blocked")).toMatchObject({ state: "retry_wait", deliveryCertainty: "not_sent" });
    expect(db.prepare("SELECT state,block_reason FROM printer_operations WHERE payload_ref='blocked'").get()).toEqual({ state: "retry_wait", block_reason: "device_fault" });
    expect(db.prepare("SELECT state FROM printer_operations WHERE payload_ref='later'").get()).toEqual({ state: "pending" });
  });

  it("prepared中断はpendingに戻し、dispatch_started中断はunknownで固定する", async () => {
    for (const [phase, expected] of [["prepared", { state: "pending", certainty: "not_sent", result: "recovered_before_dispatch" }], ["dispatch_started", { state: "failed", certainty: "unknown", result: "unknown" }]] as const) {
      const db = database(); const job = enqueueRaw(db, `job-${phase}`); const now = "2026-08-02T00:00:00.000Z";
      db.prepare("UPDATE printer_operations SET state='sending',attempt_count=1 WHERE payload_ref=?").run(job.jobId);
      db.prepare("UPDATE print_jobs SET state='sending' WHERE job_id=?").run(job.jobId);
      db.prepare("INSERT INTO print_attempts (attempt_id,job_id,attempt_no,phase,started_at,compiler_bytes_sha256) VALUES (?,?,?,?,?,?)").run(`attempt-${phase}`, job.jobId, 1, phase, now, job.bytesSha256!);
      const queue = new PersistentPrintQueue(db, { accept: async (value) => accepted(value) }, () => new Date(now)); queues.push(queue);
      expect(getPrintJob(db, job.jobId)).toMatchObject({ state: expected.state, deliveryCertainty: expected.certainty });
      expect(db.prepare("SELECT result FROM print_attempts WHERE job_id=?").get(job.jobId)).toEqual({ result: expected.result });
    }
  });
});
