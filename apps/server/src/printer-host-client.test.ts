import { describe, expect, it, vi } from "vitest";
import { HttpPrinterHostClient } from "./printer-host-client.js";

describe("HttpPrinterHostClient", () => {
  it("posts a job to the configured host", async () => {
    const result = { jobId: "j1", acceptedBytes: 1, payloadLength: 1, bytesSha256: "hash", completionEvidence: "transport_accepted", duplicate: false } as const;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(result, { status: 201 }));
    const job = { jobId: "j1", transactionId: "t1", printerId: "p1", documentType: "receipt", payload: {}, createdAt: "2026-01-01T00:00:00Z", state: "pending" as const, updatedAt: "2026-01-01T00:00:00Z" };
    expect(await new HttpPrinterHostClient("http://host:4318/").accept(job)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("http://host:4318/api/v1/print-jobs", expect.objectContaining({ method: "POST" }));
    fetchMock.mockRestore();
  });
});
