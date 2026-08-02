import type { PrinterDispatchFailure, PrinterDispatchResult, PrintJob } from "@event-pos/contracts";
import type { PrinterHost } from "./app.js";
import { PrinterHostFailure } from "./print-queue.js";

export class HttpPrinterHostClient implements PrinterHost {
  constructor(private readonly baseUrl: string) {}
  async accept(job: PrintJob): Promise<PrinterDispatchResult> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/print-jobs`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job),
    });
    const body = await response.json() as { failure?: PrinterDispatchFailure } | PrinterDispatchResult;
    if (!response.ok) {
      const failure = "failure" in body ? body.failure : undefined;
      throw new PrinterHostFailure(failure ?? { code: "PRINTER_HOST_HTTP_ERROR", message: `printer-host rejected job: ${response.status}`, acceptedBytes: 0, notSentProven: false, retryable: false, deviceFault: false });
    }
    return body as PrinterDispatchResult;
  }
}
