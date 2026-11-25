import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrintJob } from "@event-pos/contracts";
import { BUILTIN_FONT, bytesSha256, DEFAULT_FINISHING_POLICY, ESCPOS_RENDERER_VERSION, ESCPOS_RENDERER_VERSION_ROTATE180, receiptDocumentToEscPos } from "@event-pos/escpos";
import { canonicalizeReceiptDocument, type ReceiptDocument } from "@event-pos/receipt-ir";
import { buildPrinterHost } from "./app.js";
import { FakeTransport, TransportSendError, renderEscPos, statusObservation } from "./transport.js";

const apps: ReturnType<typeof buildPrinterHost>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

const document: ReceiptDocument = {
  schemaVersion: 1,
  contentWidthDots: 384,
  physicalWidthDots: 416,
  nodes: [{ kind: "reset" }, { kind: "text", value: "hello" }, { kind: "feed", lines: 3 }, { kind: "cut", mode: "partial" }],
};
const canonicalIr = canonicalizeReceiptDocument(document);
const receiptBytes = receiptDocumentToEscPos(document);
const job: PrintJob = {
  jobId: "job-1",
  transactionId: "tx-1",
  printerId: "register-1",
  documentType: "receipt",
  payload: {},
  canonicalIr,
  irSha256: bytesSha256(new TextEncoder().encode(canonicalIr)),
  bytesSha256: bytesSha256(receiptBytes),
  expectedBytesLength: receiptBytes.length,
  rendererVersion: ESCPOS_RENDERER_VERSION,
  templateKey: "sale-receipt",
  templateVersion: 1,
  templateSourceSha256: "template-v1",
  fontId: BUILTIN_FONT.id,
  fontVersion: BUILTIN_FONT.version,
  fontSha256: BUILTIN_FONT.sha256,
  finishingPolicyId: DEFAULT_FINISHING_POLICY.id,
  finishingPolicyVersion: DEFAULT_FINISHING_POLICY.version,
  createdAt: "2026-08-02T00:00:00.000Z",
  state: "pending",
  updatedAt: "2026-08-02T00:00:00.000Z",
};

describe("printer host", () => {
  it("rendererVersionで回転描画を選び、旧jobは無回転のままにする", () => {
    const rotatedBytes = receiptDocumentToEscPos(document, [], { rotate180: true });
    const rotatedJob = { ...job, rendererVersion: ESCPOS_RENDERER_VERSION_ROTATE180, bytesSha256: bytesSha256(rotatedBytes), expectedBytesLength: rotatedBytes.length };
    expect(renderEscPos(rotatedJob)).toEqual(rotatedBytes);
    expect(renderEscPos(job)).toEqual(receiptBytes);
  });

  it("reachable実測済みなら未対応sensorをunknownのままRAW送信できる", async () => {
    const transport = new FakeTransport();
    transport.getStatus = async () => ({ observedAt: new Date().toISOString(), reachable: { support: "supported", value: true }, online: { support: "unknown", reason: "RAWでは未取得" }, coverOpen: { support: "unknown", reason: "RAWでは未取得" }, drawerOpen: { support: "unknown", reason: "RAWでは未取得" }, paper: { support: "unknown", reason: "RAWでは未取得" }, error: { support: "unknown", reason: "RAWでは未取得" }, raw: null });
    const app = buildPrinterHost({ transport });
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "reachable-only" } });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ completionEvidence: "transport_accepted" });
    await app.close();
  });

  it("canonical IRを決定的に変換し、同じjobIdを1回だけ送信する", async () => {
    const transport = new FakeTransport();
    const app = buildPrinterHost({ transport }); apps.push(app);
    const first = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
    const second = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ jobId: "job-1", acceptedBytes: receiptBytes.length, bytesSha256: bytesSha256(receiptBytes), duplicate: false });
    expect(second.json()).toMatchObject({ jobId: "job-1", acceptedBytes: receiptBytes.length, duplicate: true });
    expect(transport.sent).toHaveLength(1);
    expect(Array.from(transport.sent[0] ?? [])).toEqual(Array.from(receiptBytes));
    expect(Array.from((transport.sent[0] ?? new Uint8Array()).slice(-5))).toEqual([0x0a, 0x0a, 0x0a, 0x1b, 0x69]);
  });

  it("同時の同一jobIdを一回だけ送信し、異なるpayload hashの再利用を拒否する", async () => {
    const transport = new FakeTransport();
    const app = buildPrinterHost({ transport }); apps.push(app);
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-race" } }),
      app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-race" } }),
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    expect(transport.sent).toHaveLength(1);

    const mismatch = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-race", bytesSha256: "different-hash" } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ failure: { code: "JOB_ID_PAYLOAD_MISMATCH", acceptedBytes: 0, notSentProven: true } });
    expect(transport.sent).toHaveLength(1);
  });

  it("状態不明と用紙切れをI/O前のdevice faultとして返す", async () => {
    for (const status of ["unknown", "paper_out"] as const) {
      const app = buildPrinterHost({ transport: new FakeTransport(undefined, status) }); apps.push(app);
      const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: `job-${status}` } });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ failure: { acceptedBytes: 0, notSentProven: true, deviceFault: true } });
    }
  });

  it("未送信のdevice faultを再確認し、復旧後の同時要求でも一回だけ送信する", async () => {
    const transport = new FakeTransport();
    let status = statusObservation("paper_out");
    transport.getStatus = async () => status;
    const app = buildPrinterHost({ transport, statusPollIntervalMs: 60_000 }); apps.push(app);
    const submit = () => app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });

    const first = await submit();
    expect(first.statusCode).toBe(409);
    expect(first.json()).toMatchObject({ failure: { code: "PAPER_OUT" } });

    status = { ...statusObservation("ready"), coverOpen: { support: "supported", value: true } };
    const stillBlocked = await submit();
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json()).toMatchObject({ failure: { code: "PRINTER_COVER_OPEN", acceptedBytes: 0, notSentProven: true, deviceFault: true } });
    expect(transport.sent).toHaveLength(0);

    status = statusObservation("ready");
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 201]);
    expect(responses.find((response) => response.statusCode === 200)?.json()).toMatchObject({ duplicate: true });
    expect(transport.sent).toEqual([receiptBytes]);
  });

  it("hashのないジョブも、内容を変えて同じIDで再開できない", async () => {
    const transport = new FakeTransport();
    let status = statusObservation("paper_out");
    transport.getStatus = async () => status;
    const app = buildPrinterHost({ transport, statusPollIntervalMs: 60_000 }); apps.push(app);
    const submit = (escposBase64: string) => app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: {
      jobId: "raw-retry", transactionId: "tx-raw", printerId: "receipt-1", documentType: "disaster-notification",
      source: "test", rendererVersion: "test-v1", payload: { escposBase64 },
    } });

    expect((await submit("G0A=")).json()).toMatchObject({ failure: { code: "PAPER_OUT" } });
    status = statusObservation("ready");
    const mismatch = await submit("G0o=");
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ failure: { code: "JOB_ID_PAYLOAD_MISMATCH" } });
    expect(transport.sent).toHaveLength(0);
    expect((await submit("G0A=")).statusCode).toBe(201);
    expect(transport.sent).toEqual([Uint8Array.of(0x1b, 0x40)]);
  });

  it("short writeとdispatch後例外をunknownとして固定し、再送しない", async () => {
    const shortTransport = new FakeTransport(undefined, "ready", 1);
    const shortApp = buildPrinterHost({ transport: shortTransport }); apps.push(shortApp);
    const first = await shortApp.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-short" } });
    const duplicate = await shortApp.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-short" } });
    expect(first.json()).toMatchObject({ failure: { code: "SHORT_WRITE", acceptedBytes: 1, notSentProven: false } });
    expect(duplicate.json()).toMatchObject({ failure: { code: "SHORT_WRITE" }, duplicate: true });
    expect(shortTransport.sent).toHaveLength(1);

    const timeoutTransport = new FakeTransport(new TransportSendError("timeout", 0, false), "ready");
    const send = vi.spyOn(timeoutTransport, "send");
    const timeoutApp = buildPrinterHost({ transport: timeoutTransport }); apps.push(timeoutApp);
    const timeout = await timeoutApp.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-timeout" } });
    const timeoutDuplicate = await timeoutApp.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-timeout" } });
    expect(timeout.json()).toMatchObject({ failure: { code: "TRANSPORT_ERROR", acceptedBytes: 0, notSentProven: false } });
    expect(timeoutDuplicate.json()).toEqual({ ...timeout.json(), duplicate: true });
    expect(send).toHaveBeenCalledOnce();
  });

  it("承認済み外部rendererのESC/POS bytesだけを無変換で渡す", async () => {
    const transport = new FakeTransport();
    const app = buildPrinterHost({ transport }); apps.push(app);
    const raw = Uint8Array.from([0x1b, 0x40, 0x0a, 0x1b, 0x69]);
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "job-external", documentType: "disaster-notification", payload: { escposBase64: Buffer.from(raw).toString("base64") }, canonicalIr: undefined, irSha256: undefined, expectedBytesLength: raw.length, bytesSha256: bytesSha256(raw), source: "kishou_server", sourceEventId: "eq-1", rendererVersion: "kishou-escpos-v1" } });
    expect(response.json()).toMatchObject({ jobId: "job-external", acceptedBytes: raw.length });
    expect(Array.from(transport.sent[0] ?? [])).toEqual(Array.from(raw));
  });

  it("既定のBC-415M用2番pin 40ms pulseをdrawer jobとして送信する", async () => {
    const transport = new FakeTransport(); const app = buildPrinterHost({ transport }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "drawer-1", documentType: "drawer", kind: "drawer", payload: { pin: 2, onMs: 40, offMs: 200 }, canonicalIr: undefined, irSha256: undefined, expectedBytesLength: 5, bytesSha256: "e11e22d0c2538e1cd892e671b4915e0cf57a34d71f54ea1712fbd9629a024134", rendererVersion: "event-pos-drawer-v1" } });
    expect(response.statusCode).toBe(201);
    expect(Array.from(transport.sent[0] ?? [])).toEqual([0x1b, 0x70, 0x00, 0x14, 0x64]);
  });

  it("定期取得済みの状態をdrawer駆動に再利用する", async () => {
    const transport = new FakeTransport(); let statusCalls = 0; const originalStatus = transport.getStatus.bind(transport); transport.getStatus = async () => { statusCalls += 1; return await originalStatus(); };
    const app = buildPrinterHost({ transport, statusPollIntervalMs: 60_000 }); apps.push(app);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "drawer-no-status", documentType: "drawer", kind: "drawer", payload: { pin: 2, onMs: 40, offMs: 200 }, canonicalIr: undefined, irSha256: undefined, expectedBytesLength: 5, bytesSha256: "e11e22d0c2538e1cd892e671b4915e0cf57a34d71f54ea1712fbd9629a024134", rendererVersion: "event-pos-drawer-v1" } });
    expect(response.statusCode).toBe(201);
    expect(statusCalls).toBe(1);
    expect(Array.from(transport.sent[0] ?? [])).toEqual([0x1b, 0x70, 0x00, 0x14, 0x64]);
  });

  it("status取得と印刷送信を同じprinter mutexで直列化する", async () => {
    const transport = new FakeTransport(); const statusObservation = await transport.getStatus(); let active = 0; let maxActive = 0;
    const enter = async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; };
    transport.getStatus = async () => { await enter(); return statusObservation; };
    transport.send = async (bytes) => { await enter(); return { acceptedBytes: bytes.length, transportEvidence: { adapter: "fake", acceptedBytes: bytes.length } }; };
    const app = buildPrinterHost({ transport }); apps.push(app);
    const [status, print] = await Promise.all([
      app.inject({ method: "GET", url: "/api/v1/printer/status" }),
      app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: "mutex-job" } }),
    ]);
    expect(status.statusCode).toBe(200); expect(print.statusCode).toBe(201); expect(maxActive).toBe(1);
  });

  it("許可済みdrawer診断pulseだけをpin別・時間別に送信する", async () => {
    for (const [name, payload, bytes] of [
      ["pin2-40", { pin: 2, onMs: 40, offMs: 200 }, [0x1b, 0x70, 0x00, 0x14, 0x64]],
      ["pin2-80", { pin: 2, onMs: 80, offMs: 400 }, [0x1b, 0x70, 0x00, 0x28, 0xc8]],
      ["pin5-40", { pin: 5, onMs: 40, offMs: 200 }, [0x1b, 0x70, 0x01, 0x14, 0x64]],
      ["pin5-80", { pin: 5, onMs: 80, offMs: 400 }, [0x1b, 0x70, 0x01, 0x28, 0xc8]],
    ] as const) {
      const transport = new FakeTransport(); const app = buildPrinterHost({ transport }); apps.push(app);
      const value = Uint8Array.from(bytes);
      const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { ...job, jobId: `drawer-${name}`, documentType: "drawer", kind: "drawer", payload, canonicalIr: undefined, irSha256: undefined, expectedBytesLength: value.length, bytesSha256: bytesSha256(value), rendererVersion: "event-pos-drawer-v1" } });
      expect(response.statusCode).toBe(201);
      expect(Array.from(transport.sent.at(-1) ?? [])).toEqual(bytes);
    }
  });
});
