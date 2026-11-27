import { describe, expect, it, vi } from "vitest";
import { HttpPrinterHostClient } from "./printer-host-client.js";
import { PrinterHostFailure } from "./print-queue.js";

describe("HttpPrinterHostClient", () => {
  it("posts a job to the configured host", async () => {
    const result = { jobId: "j1", acceptedBytes: 1, payloadLength: 1, bytesSha256: "hash", completionEvidence: "transport_accepted", duplicate: false } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(result, { status: 201 }));
    const job = { jobId: "j1", transactionId: "t1", printerId: "p1", documentType: "receipt", payload: {}, createdAt: "2026-01-01T00:00:00Z", state: "pending" as const, updatedAt: "2026-01-01T00:00:00Z" };
    expect(await new HttpPrinterHostClient("http://host:4318/").accept(job)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("http://host:4318/api/v1/print-jobs", expect.objectContaining({ method: "POST" }));
    fetchMock.mockRestore();
  });

  it("sends the configured token as a Bearer header", async () => {
    const result = { jobId: "j1", acceptedBytes: 1, payloadLength: 1, bytesSha256: "hash", completionEvidence: "transport_accepted", duplicate: false } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(result, { status: 201 }));
    const job = { jobId: "j1", transactionId: "t1", printerId: "p1", documentType: "receipt", payload: {}, createdAt: "2026-01-01T00:00:00Z", state: "pending" as const, updatedAt: "2026-01-01T00:00:00Z" };
    await new HttpPrinterHostClient("http://host:4318", 15_000, "secret-token").accept(job);
    expect(fetchMock).toHaveBeenCalledWith("http://host:4318/api/v1/print-jobs", expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer secret-token" }) }));
    fetchMock.mockRestore();
  });

  it("classifies connection refusal as provably not sent, and other fetch failures as unknown (F-091)", async () => {
    const job = { jobId: "j1", transactionId: "t1", printerId: "p1", documentType: "receipt", payload: {}, createdAt: "2026-01-01T00:00:00Z", state: "pending" as const, updatedAt: "2026-01-01T00:00:00Z" };
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(refused);
    const refusedError = await new HttpPrinterHostClient("http://host:4318").accept(job).catch((cause: unknown) => cause);
    expect(refusedError).toBeInstanceOf(PrinterHostFailure);
    expect((refusedError as PrinterHostFailure).failure).toMatchObject({ code: "PRINTER_HOST_UNREACHABLE", notSentProven: true, acceptedBytes: 0 });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const unknownError = await new HttpPrinterHostClient("http://host:4318").accept(job).catch((cause: unknown) => cause);
    expect((unknownError as PrinterHostFailure).failure).toMatchObject({ code: "PRINTER_HOST_RESULT_UNKNOWN", notSentProven: false });
    fetchMock.mockRestore();
  });

  it("classifies 401 as an unauthorized failure that was provably not sent", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "unauthorized" }, { status: 401 }));
    const job = { jobId: "j1", transactionId: "t1", printerId: "p1", documentType: "receipt", payload: {}, createdAt: "2026-01-01T00:00:00Z", state: "pending" as const, updatedAt: "2026-01-01T00:00:00Z" };
    const error = await new HttpPrinterHostClient("http://host:4318", 15_000, "wrong-token").accept(job).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(PrinterHostFailure);
    expect((error as PrinterHostFailure).failure).toMatchObject({ code: "PRINTER_HOST_UNAUTHORIZED", notSentProven: true, acceptedBytes: 0, deviceFault: false });
    fetchMock.mockRestore();
  });
});
