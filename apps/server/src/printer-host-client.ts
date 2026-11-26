import type { PrinterDispatchFailure, PrinterDispatchResult, PrinterStatusObservation, PrintJob } from "@event-pos/contracts";
import type { PrinterHost } from "./app.js";
import { PrinterHostFailure } from "./print-queue.js";

export class HttpPrinterHostClient implements PrinterHost {
  constructor(private readonly baseUrl: string, private readonly timeoutMs = 15_000, private readonly authToken?: string) {}
  private get headers(): Record<string, string> { return this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}; }
  async accept(job: PrintJob): Promise<PrinterDispatchResult> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/print-jobs`, { method: "POST", headers: { ...this.headers, "content-type": "application/json" }, body: JSON.stringify(job), signal: AbortSignal.timeout(this.timeoutMs) }); }
    catch { throw new PrinterHostFailure({ code: "PRINTER_HOST_RESULT_UNKNOWN", message: "PrinterHostの送信結果を確認できません", acceptedBytes: 0, notSentProven: false, retryable: false, deviceFault: false }); }
    const body = await response.json() as { failure?: PrinterDispatchFailure } | PrinterDispatchResult;
    if (response.status === 401) {
      // 認証で弾かれた時点でジョブは PrinterHost に届いていない（未送信が確定する）。
      throw new PrinterHostFailure({ code: "PRINTER_HOST_UNAUTHORIZED", message: "PrinterHostの認証に失敗しました（PRINTER_HOST_TOKENが一致していません）。印刷は送信されていません", acceptedBytes: 0, notSentProven: true, retryable: false, deviceFault: false });
    }
    if (!response.ok) {
      const failure = "failure" in body ? body.failure : undefined;
      throw new PrinterHostFailure(failure ?? { code: "PRINTER_HOST_HTTP_ERROR", message: `printer-host rejected job: ${response.status}`, acceptedBytes: 0, notSentProven: false, retryable: false, deviceFault: false });
    }
    return body as PrinterDispatchResult;
  }
  async getStatus(): Promise<PrinterStatusObservation> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1/printer/status`, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      if (!response.ok) throw new Error("status failed");
      return (await response.json() as { observation: PrinterStatusObservation }).observation;
    } catch { return { observedAt: new Date().toISOString(), reachable: { support: "unknown", reason: "PrinterHostへ接続できません" }, online: { support: "unknown", reason: "PrinterHostへ接続できません" }, coverOpen: { support: "unknown", reason: "PrinterHostへ接続できません" }, drawerOpen: { support: "unknown", reason: "PrinterHostへ接続できません" }, paper: { support: "unknown", reason: "PrinterHostへ接続できません" }, error: { support: "unknown", reason: "PrinterHostへ接続できません" }, raw: null }; }
  }
}
