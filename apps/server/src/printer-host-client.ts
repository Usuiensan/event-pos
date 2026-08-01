import type { PrintJob } from "@event-pos/contracts";
import type { PrinterHost } from "./app.js";

export class HttpPrinterHostClient implements PrinterHost {
  constructor(private readonly baseUrl: string) {}
  async accept(job: PrintJob): Promise<void> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/print-jobs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job),
    });
    if (!response.ok) throw new Error(`printer-host rejected job: ${response.status}`);
  }
}
