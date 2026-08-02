import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { createPrintJob, openDatabase } from "./db.js";
import { bytesSha256 } from "@event-pos/escpos";
import Fastify from "fastify";
import { HttpPrinterHostClient } from "./printer-host-client.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("server foundation", () => {
  it("システムエラーレポートをError IDごとのtxtへ保存する", async () => {
    const reportDirectory = mkdtempSync(join(tmpdir(), "event-pos-error-report-"));
    try {
      const app = buildApp({ database: openDatabase(), errorReportDirectory: reportDirectory }); apps.push(app);
      const errorId = "019fc3fb-f939-7e30-8175-635f2866b280";
      const response = await app.inject({ method: "POST", url: "/api/v1/error-reports", payload: { errorId, content: "Error ID\n019fc3fb-f939-7e30-8175-635f2866b280\n\nStack Trace\ntest" } });
      expect(response.statusCode).toBe(201);
      expect(readFileSync(join(reportDirectory, `${errorId}.txt`), "utf8")).toContain("Stack Trace\ntest");
    } finally { rmSync(reportDirectory, { recursive: true, force: true }); }
  });

  it("calculates cash check theoretical amount from the server ledger", async () => {
    const database = openDatabase(); const app = buildApp({ database }); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "cash-1", eventId: "event-1", businessDate: "2026-08-02", cashboxId: "box-1" } })).json()).toMatchObject({ cashboxId: "box-1", state: "open" });
    const opening = await app.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-1/checks/opening", payload: { counted: [{ denomination: 1000, quantity: 1 }] } });
    expect(opening.json().printJobId).toEqual(expect.any(String));
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-1/movements", payload: { type: "sale", amountYen: 500, reason: "test sale", idempotencyKey: "sale-1" } });
    const interim = await app.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-1/checks/interim", payload: { counted: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }] } });
    expect(interim.statusCode).toBe(201); expect(interim.json()).toMatchObject({ theoreticalYen: 1500, countedYen: 1500, differenceYen: 0 });
    const closing = await app.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-1/checks/closing", payload: { counted: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }], carryoverYen: 1000 } });
    expect(closing.statusCode).toBe(201);
    expect(database.prepare("SELECT kind,document_type,state FROM print_jobs ORDER BY created_at,kind").all()).toEqual([
      { kind: "opening", document_type: "cash-check", state: "pending" }, { kind: "interim", document_type: "cash-check", state: "pending" }, { kind: "closing", document_type: "cash-check", state: "pending" },
    ]);
    const cashReceipts = database.prepare("SELECT canonical_ir,renderer_version,finishing_policy_id,finishing_policy_version FROM print_jobs ORDER BY created_at,kind").all() as Array<Record<string, unknown>>;
    expect(cashReceipts).toHaveLength(3);
    for (const receipt of cashReceipts) expect(receipt).toMatchObject({ renderer_version: "event-pos-cash-check-v2", finishing_policy_id: "receipt-partial-cut", finishing_policy_version: 2, canonical_ir: expect.stringContaining("!feed 8") });
    expect(database.prepare("SELECT kind,sequence FROM printer_operations ORDER BY sequence").all()).toEqual([{ kind: "print", sequence: 1 }, { kind: "print", sequence: 2 }, { kind: "print", sequence: 3 }]);
  });
  it("rejects duplicate closing and idempotency payload changes", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "s1", eventId: "e1", businessDate: "2026-08-02" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/checks/opening", payload: { counted: [{ denomination: 1000, quantity: 1 }] } })).statusCode).toBe(201);
    const movement = { type: "sale", amountYen: 100, reason: "sale", idempotencyKey: "same" };
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/movements", payload: movement })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/movements", payload: { ...movement, amountYen: 200 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/checks/closing", payload: { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000 } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/checks/closing", payload: { counted: [{ denomination: 1000, quantity: 1 }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/s1/movements", payload: { ...movement, idempotencyKey: "after-close" } })).statusCode).toBe(400);
  });
  it("restores cash session, ledger, check, and closed state after SQLite reopen", async () => {
    const databasePath = "./.cash-persistence-test.sqlite";
    rmSync(databasePath, { force: true }); rmSync(`${databasePath}-wal`, { force: true }); rmSync(`${databasePath}-shm`, { force: true });
    const database = openDatabase(databasePath); const app = buildApp({ database }); apps.push(app);
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "persist-1", eventId: "e1", businessDate: "2026-08-02" } });
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/persist-1/checks/opening", payload: { counted: [{ denomination: 1000, quantity: 1 }], actorId: "staff-1", terminalId: "register-1" } });
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/persist-1/movements", payload: { type: "sale", amountYen: 500, reason: "sale", idempotencyKey: "persist-sale", actorId: "staff-1", terminalId: "register-1" } });
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/persist-1/checks/closing", payload: { counted: [{ denomination: 1000, quantity: 1 }, { denomination: 500, quantity: 1 }], carryoverYen: 1000 } });
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const app2 = buildApp({ database: openDatabase(databasePath) }); apps.push(app2);
    const replay = await app2.inject({ method: "POST", url: "/api/v1/cash-sessions/persist-1/movements", payload: { type: "sale", amountYen: 500, reason: "sale", idempotencyKey: "persist-sale" } });
    expect(replay.statusCode).toBe(400);
    const reopen = await app2.inject({ method: "POST", url: "/api/v1/cash-sessions/persist-1/reopen", payload: { reason: "確認のため再開", actorId: "manager-1", terminalId: "register-1" } });
    expect(reopen.statusCode).toBe(200);
    await app2.close(); apps.splice(apps.indexOf(app2), 1);
    rmSync(databasePath, { force: true }); rmSync(`${databasePath}-wal`, { force: true }); rmSync(`${databasePath}-shm`, { force: true });
  });
  it("enforces cash roles when enabled without logging credentials", async () => {
    const app = buildApp({ database: openDatabase(), requireCashAuth: true }); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "auth-1", eventId: "e1", businessDate: "2026-08-02" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions", headers: { "x-pos-role": "operator", "x-pos-actor-id": "staff-1" }, payload: { sessionId: "auth-1", eventId: "e1", businessDate: "2026-08-02" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/auth-1/reopen", headers: { "x-pos-role": "operator", "x-pos-actor-id": "staff-1" }, payload: { reason: "no" } })).statusCode).toBe(403);
  });
  it("rejects concurrent duplicate opening", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const responses = await Promise.all([1, 2].map(() => app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "concurrent-1", eventId: "e1", businessDate: "2026-08-02" } })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
  });
  it("commits sale transaction and cash movement atomically", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "tx-1", eventId: "e1", businessDate: "2026-08-02" } });
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/tx-1/checks/opening", payload: { counted: [{ denomination: 1000, quantity: 1 }] } });
    const result = await app.inject({ method: "POST", url: "/api/v1/cash-sessions/tx-1/transactions/sale", payload: { transactionId: "T-1", amountYen: 300, idempotencyKey: "tx-key", reason: "商品売上" } });
    expect(result.statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/tx-1/transactions/sale", payload: { transactionId: "T-1", amountYen: 300, idempotencyKey: "tx-key" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/tx-1/transactions/sale", payload: { transactionId: "T-2", amountYen: 400, idempotencyKey: "tx-key" } })).statusCode).toBe(409);
  });
  it("records returns as negative cash movement with manager authorization", async () => {
    const app = buildApp({ database: openDatabase(), requireCashAuth: true }); apps.push(app);
    const headers = { "x-pos-role": "operator", "x-pos-actor-id": "staff-1" };
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions", headers, payload: { sessionId: "return-1", eventId: "e1", businessDate: "2026-08-02" } });
    await app.inject({ method: "POST", url: "/api/v1/cash-sessions/return-1/checks/opening", headers, payload: { counted: [{ denomination: 1000, quantity: 1 }] } });
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/return-1/transactions/return", headers, payload: { transactionId: "R-1", amountYen: 100, idempotencyKey: "return-key" } })).statusCode).toBe(403);
    const managerHeaders = { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" };
    expect((await app.inject({ method: "POST", url: "/api/v1/cash-sessions/return-1/transactions/return", headers: managerHeaders, payload: { transactionId: "R-1", amountYen: 100, idempotencyKey: "return-key" } })).statusCode).toBe(201);
    const check = await app.inject({ method: "POST", url: "/api/v1/cash-sessions/return-1/checks/interim", headers, payload: { counted: [{ denomination: 1000, quantity: 1 }] } });
    expect(check.json()).toMatchObject({ theoreticalYen: 900 });
  });
  it("persists and restores an event catalog through the API", async () => {
    const databasePath = "./.catalog-persistence-test.sqlite";
    rmSync(databasePath, { force: true }); rmSync(`${databasePath}-wal`, { force: true }); rmSync(`${databasePath}-shm`, { force: true });
    const database = openDatabase(databasePath);
    const app = buildApp({ database });
    apps.push(app);
    const catalog = { eventId: "event-catalog", products: [{ productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", internalToken: "P1A001" }], quickEntries: [{ id: "set-1", label: "セット", components: [{ productCode: "A001", quantity: 2 }] }] };
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/event-catalog/catalog", payload: catalog })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/v1/events/event-catalog/catalog" })).json().catalog).toEqual(catalog);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    const app2 = buildApp({ database: openDatabase(databasePath) });
    apps.push(app2);
    expect((await app2.inject({ method: "GET", url: "/api/v1/events/event-catalog/catalog" })).json().catalog).toEqual(catalog);
    await app2.close(); apps.splice(apps.indexOf(app2), 1);
    rmSync(databasePath, { force: true }); rmSync(`${databasePath}-wal`, { force: true }); rmSync(`${databasePath}-shm`, { force: true });
  });

  it("rejects invalid catalog references and duplicate product codes", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const product = { productCode: "A", name: "A", priceInclTax: 100, taxRate: 10, saleState: "on_sale" } as const;
    const base = { eventId: "event-invalid", products: [product], quickEntries: [] };
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/event-invalid/catalog", payload: { ...base, products: [product, product] } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/v1/events/event-invalid/catalog", payload: { ...base, quickEntries: [{ id: "q", label: "bad", components: [{ productCode: "missing", quantity: 1 }] }] } })).statusCode).toBe(400);
  });

  it("serves live, ready, and info endpoints against SQLite", async () => {
    const app = buildApp({ database: openDatabase() });
    apps.push(app);
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/health/ready")).json()).toEqual({ status: "ok", database: "ok" });
    expect((await app.inject("/api/v1/info")).json()).toMatchObject({ name: "event-pos", schemaVersion: 1 });
  });

  it("persists a print job and drives its state through a fake printer host", async () => {
    const database = openDatabase();
    const accepted: string[] = [];
    const app = buildApp({ database, printerHost: { accept: async (job) => { accepted.push(job.jobId); return { jobId: job.jobId, acceptedBytes: job.expectedBytesLength!, payloadLength: job.expectedBytesLength!, bytesSha256: job.bytesSha256!, completionEvidence: "transport_accepted", duplicate: false }; } } });
    apps.push(app);
    const request = { jobId: "job-1", transactionId: "tx-1", printerId: "register-1", documentType: "disaster-notification", payload: { escposBase64: Buffer.from("test").toString("base64") }, createdAt: "2026-08-02T00:00:00.000Z", source: "test", rendererVersion: "test-v1" };
    const created = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: request });
    expect(created.statusCode).toBe(201);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(accepted).toEqual(["job-1"]);
    expect(created.json()).toMatchObject({ jobId: "job-1", state: "pending" });
    const printing = await app.inject({ method: "PATCH", url: "/api/v1/print-jobs/job-1/state", payload: { state: "printing" } });
    expect(printing.json()).toMatchObject({ jobId: "job-1", state: "sending" });
    const completed = await app.inject({ method: "PATCH", url: "/api/v1/print-jobs/job-1/state", payload: { state: "completed" } });
    expect(completed.json()).toMatchObject({ jobId: "job-1", state: "completed" });
  });

  it("forwards a persisted job to an HTTP printer host", async () => {
    const host = Fastify({ logger: false });
    const received: unknown[] = [];
    host.post("/api/v1/print-jobs", async (request, reply) => { const job = request.body as { jobId: string; expectedBytesLength: number; bytesSha256: string }; received.push(request.body); return reply.code(201).send({ jobId: job.jobId, acceptedBytes: job.expectedBytesLength, payloadLength: job.expectedBytesLength, bytesSha256: job.bytesSha256, completionEvidence: "transport_accepted", duplicate: false }); });
    await host.listen({ host: "127.0.0.1", port: 0 });
    const address = host.server.address();
    if (!address || typeof address === "string") throw new Error("test host did not bind a TCP port");
    const app = buildApp({ database: openDatabase(), printerHost: new HttpPrinterHostClient(`http://127.0.0.1:${address.port}`) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId: "http-job", transactionId: "http-tx", printerId: "register-1", documentType: "disaster-notification", payload: { lines: ["速報"], escposBase64: Buffer.from("速報").toString("base64") }, createdAt: "2026-08-02T00:00:00.000Z", source: "kishou_server", sourceEventId: "event-1", rendererVersion: "kishou-v1" } });
    expect(response.statusCode).toBe(201);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({ jobId: "http-job", documentType: "disaster-notification", source: "kishou_server" });
    const latestAlert = await app.inject({ method: "GET", url: "/api/v1/emergency-alerts/latest" });
    expect(latestAlert.json().alert).toMatchObject({ id: "http-job", title: "緊急情報", message: "速報", source: "kishou_server" });
    await host.close();
  });

  it("起動時にSQLiteの未完了jobを取得してPrinterHostへ送る", async () => {
    const database = openDatabase(); const raw = Uint8Array.from([0x1b, 0x40, 0x0a, 0x1b, 0x69]);
    createPrintJob(database, { jobId: "restart-job", transactionId: "restart-tx", printerId: "register-1", documentType: "disaster-notification", payload: { escposBase64: Buffer.from(raw).toString("base64") }, createdAt: "2026-08-02T00:00:00.000Z", source: "test", rendererVersion: "test-v1", bytesSha256: bytesSha256(raw), expectedBytesLength: raw.length });
    const accepted: string[] = [];
    const app = buildApp({ database, printerHost: { accept: async (job) => { accepted.push(job.jobId); return { jobId: job.jobId, acceptedBytes: job.expectedBytesLength!, payloadLength: job.expectedBytesLength!, bytesSha256: job.bytesSha256!, completionEvidence: "transport_accepted", duplicate: false }; } } });
    apps.push(app);
    await vi.waitFor(() => expect(accepted).toEqual(["restart-job"]));
    expect((await app.inject("/api/v1/print-jobs/restart-job")).json()).toMatchObject({ state: "completed", deliveryCertainty: "accepted" });
  });
});
