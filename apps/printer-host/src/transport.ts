import type { PrintJob } from "@event-pos/contracts";

export type PrinterStatus = "ready" | "paper_out" | "offline" | "unknown";
export type PrinterTransport = {
  getStatus(): Promise<PrinterStatus>;
  send(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export function renderEscPos(job: PrintJob): Uint8Array {
  const payload = job.payload as { lines?: unknown };
  if (payload && typeof payload === "object" && typeof (payload as { escposBase64?: unknown }).escposBase64 === "string") {
    return Uint8Array.from(Buffer.from((payload as { escposBase64: string }).escposBase64, "base64"));
  }
  const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : [job.documentType, job.transactionId];
  // TM-T70IIはカット位置まで紙送りしてからカットする。即時カットでは最終行が切れる。
  return Uint8Array.from([...new TextEncoder().encode(`${lines.join("\n")}\n\n\n`), 0x1d, 0x56, 0x00]);
}

export class FakeTransport implements PrinterTransport {
  readonly sent: Uint8Array[] = [];
  constructor(private readonly failure?: Error, private readonly status: PrinterStatus = failure ? "unknown" : "ready") {}
  async getStatus(): Promise<PrinterStatus> { return this.status; }
  async send(bytes: Uint8Array): Promise<void> { if (this.failure) throw this.failure; this.sent.push(bytes); }
  async close(): Promise<void> {}
}
