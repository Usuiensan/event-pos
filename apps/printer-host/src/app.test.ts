import { afterEach, describe, expect, it } from "vitest";
import { buildPrinterHost } from "./app.js";
import { FakeTransport } from "./transport.js";

const apps: ReturnType<typeof buildPrinterHost>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

const job = { jobId: "job-1", transactionId: "tx-1", printerId: "register-1", documentType: "receipt", payload: { lines: ["hello"] }, createdAt: "2026-08-02T00:00:00.000Z", state: "queued" as const, updatedAt: "2026-08-02T00:00:00.000Z" };

describe("printer host", () => {
  it("renders and sends once, returning the same job for duplicate jobId", async () => {
    const transport = new FakeTransport();
    const app = buildPrinterHost({ transport }); apps.push(app);
    const first = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
    const second = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
    expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ state: "completed" });
    expect(transport.sent).toHaveLength(1);
    expect(new TextDecoder().decode(transport.sent[0])).toContain("hello");
  });

  it("marks an unavailable printer as unknown", async () => {
    const app = buildPrinterHost({ transport: new FakeTransport(new Error("usb unavailable")) }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: job });
    expect(response.json()).toMatchObject({ state: "unknown", errorMessage: "printer_not_ready" });
  });
});
