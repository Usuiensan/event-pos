import type { PrintJobStateUpdate } from "@event-pos/contracts";
import type { StateSink } from "./app.js";

export class HttpStateSink implements StateSink {
  constructor(private readonly posBaseUrl: string) {}
  async update(jobId: string, update: PrintJobStateUpdate): Promise<void> {
    const response = await fetch(`${this.posBaseUrl.replace(/\/$/, "")}/api/v1/print-jobs/${encodeURIComponent(jobId)}/state`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(update),
    });
    if (!response.ok) throw new Error(`POS state update failed: ${response.status}`);
  }
}
