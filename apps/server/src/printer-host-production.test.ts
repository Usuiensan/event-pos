import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildPrinterHost, type PrinterHostLogEvent } from "@event-pos/printer-host/app";
import { statusObservation, type PrinterTransport } from "@event-pos/printer-host/transport";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { HttpPrinterHostClient } from "./printer-host-client.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

describe("POSから本番PrinterHostまでの統合", () => {
  it("初回・再印刷・開局/中間計/精算を永続FIFO先頭から1件ずつHTTP送信する", async () => {
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sentLengths: number[] = [];
    const transport: PrinterTransport = {
      async getStatus() { return statusObservation("ready", { adapter: "production-integration-test" }); },
      async send(bytes) {
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        if (sentLengths.length === 0) await firstBlocked;
        sentLengths.push(bytes.length);
        activeWrites -= 1;
        return { acceptedBytes: bytes.length, transportEvidence: { adapter: "production-integration-test", acceptedBytes: bytes.length } };
      },
      async close() {},
    };
    const hostEvents: PrinterHostLogEvent[] = [];
    const host = buildPrinterHost({ transport, log: (event) => hostEvents.push(event) });
    apps.push(host);
    await host.listen({ host: "127.0.0.1", port: 0 });
    const address = host.server.address();
    if (!address || typeof address === "string") throw new Error("PrinterHost test portを取得できません");

    const database = openDatabase();
    const pos = buildApp({ database, drawerEnabled: false, printerHost: new HttpPrinterHostClient(`http://127.0.0.1:${address.port}`) });
    apps.push(pos);
    expect((await pos.inject({ method: "POST", url: "/api/v1/cash-sessions", payload: { sessionId: "cash-production", eventId: "event-production", businessDate: "2026-08-03" } })).statusCode).toBe(201);
    expect((await pos.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-production/checks/opening", payload: { counted: [{ denomination: 1000, quantity: 1 }] } })).statusCode).toBe(201);
    await vi.waitFor(() => expect(hostEvents.some((event) => event.event === "dispatch_started")).toBe(true));

    const catalog = { eventId: "event-production", customerWelcome: { circleName: "本番経路試験" }, products: [{ productCode: "00000001", name: "新刊", priceInclTax: 500, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale" }], quickEntries: [], autoDiscountRules: [] };
    expect((await pos.inject({ method: "PUT", url: "/api/v1/events/event-production/catalog", payload: catalog })).statusCode).toBe(200);
    let draft = (await pos.inject({ method: "POST", url: "/api/v1/registers/register-1/sale-drafts", payload: { eventId: "event-production", staffId: "staff-001", terminalId: "register-1", businessDate: "2026-08-03", sessionNo: 1 } })).json();
    draft = (await pos.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001", quantity: 1 } })).json();
    draft = (await pos.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(draft.version) }, payload: { kind: "cash", amountYen: 500, tenderedYen: 1000 } })).json();
    const saleResponse = await pos.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": "production-path-sale" }, payload: { version: draft.version } });
    expect(saleResponse.statusCode, saleResponse.body).toBe(201);
    const sale = saleResponse.json();
    const reprintResponse = await pos.inject({ method: "POST", url: `/api/v1/transactions/${sale.transactionId}/reprints`, headers: { "x-pos-role": "manager", "x-pos-actor-id": "manager-1" }, payload: { sourcePrintJobId: sale.printJobId, reason: "統合試験", physicalOutcome: "printed", riskAccepted: true, approval: { approverId: "manager-1", approvedAt: "2026-08-03T00:00:00.000Z" } } });
    expect(reprintResponse.statusCode, reprintResponse.body).toBe(201);
    expect((await pos.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-production/checks/interim", payload: { counted: [{ denomination: 1000, quantity: 1 }] } })).statusCode).toBe(201);
    expect((await pos.inject({ method: "POST", url: "/api/v1/cash-sessions/cash-production/checks/closing", payload: { counted: [{ denomination: 1000, quantity: 1 }], carryoverYen: 1000 } })).statusCode).toBe(201);

    expect(database.prepare("SELECT kind FROM print_jobs ORDER BY rowid").all()).toEqual([{ kind: "opening" }, { kind: "original" }, { kind: "reprint" }, { kind: "interim" }, { kind: "closing" }]);
    releaseFirst();
    await vi.waitFor(() => expect(database.prepare("SELECT COUNT(*) AS count FROM print_jobs WHERE state='completed'").get()).toEqual({ count: 5 }), { timeout: 5_000 });

    const acceptedEvents = hostEvents.filter((event) => event.event === "transport_accepted");
    const expectedJobIds = (database.prepare("SELECT payload_ref AS jobId FROM printer_operations ORDER BY sequence").all() as Array<{ jobId: string }>).map((row) => row.jobId);
    expect(acceptedEvents.map((event) => event.jobId)).toEqual(expectedJobIds);
    expect(acceptedEvents.every((event) => event.bytesSha256 && event.acceptedBytes === event.payloadLength)).toBe(true);
    expect(maxActiveWrites).toBe(1);
    expect(sentLengths).toHaveLength(5);
    expect(database.prepare("SELECT COUNT(*) AS count FROM print_attempts WHERE phase='postcheck_completed' AND accepted_bytes > 0 AND compiler_bytes_sha256=adapter_bytes_sha256 AND adapter_bytes_sha256=write_bytes_sha256").get()).toEqual({ count: 5 });
  });
});
