import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import Fastify from "fastify";
import { HttpPrinterHostClient } from "./printer-host-client.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("server foundation", () => {
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
    const app = buildApp({ database, printerHost: { accept: async (job) => { accepted.push(job.jobId); } } });
    apps.push(app);
    const request = { jobId: "job-1", transactionId: "tx-1", printerId: "register-1", documentType: "receipt", payload: { lines: ["test"] }, createdAt: "2026-08-02T00:00:00.000Z" };
    const created = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: request });
    expect(created.statusCode).toBe(201);
    expect(accepted).toEqual(["job-1"]);
    expect(created.json()).toMatchObject({ jobId: "job-1", state: "queued" });
    const printing = await app.inject({ method: "PATCH", url: "/api/v1/print-jobs/job-1/state", payload: { state: "printing" } });
    expect(printing.json()).toMatchObject({ jobId: "job-1", state: "printing" });
    const completed = await app.inject({ method: "PATCH", url: "/api/v1/print-jobs/job-1/state", payload: { state: "completed" } });
    expect(completed.json()).toMatchObject({ jobId: "job-1", state: "completed" });
  });

  it("forwards a persisted job to an HTTP printer host", async () => {
    const host = Fastify({ logger: false });
    const received: unknown[] = [];
    host.post("/api/v1/print-jobs", async (request, reply) => { received.push(request.body); return reply.code(201).send(request.body); });
    await host.listen({ host: "127.0.0.1", port: 0 });
    const address = host.server.address();
    if (!address || typeof address === "string") throw new Error("test host did not bind a TCP port");
    const app = buildApp({ database: openDatabase(), printerHost: new HttpPrinterHostClient(`http://127.0.0.1:${address.port}`) });
    apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/print-jobs", payload: { jobId: "http-job", transactionId: "http-tx", printerId: "register-1", documentType: "disaster-notification", payload: { lines: ["速報"] }, createdAt: "2026-08-02T00:00:00.000Z", source: "kishou_server", sourceEventId: "event-1" } });
    expect(response.statusCode).toBe(201);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ jobId: "http-job", documentType: "disaster-notification", source: "kishou_server" });
    await host.close();
  });
});
