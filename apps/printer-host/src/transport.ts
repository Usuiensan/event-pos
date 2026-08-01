import type { PrintJob } from "@event-pos/contracts";

export type PrinterStatus = "ready" | "paper_out" | "offline" | "unknown";
export type PrinterTransport = {
  getStatus(): Promise<PrinterStatus>;
  send(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

export function renderEscPos(job: PrintJob): Uint8Array {
  const payload = job.payload as { lines?: unknown };
  const lines = Array.isArray(payload.lines) ? payload.lines.map(String) : [job.documentType, job.transactionId];
  return new TextEncoder().encode(`${lines.join("\n")}\n\n`);
}

export class FakeTransport implements PrinterTransport {
  readonly sent: Uint8Array[] = [];
  constructor(private readonly failure?: Error) {}
  async getStatus(): Promise<PrinterStatus> { return this.failure ? "unknown" : "ready"; }
  async send(bytes: Uint8Array): Promise<void> { if (this.failure) throw this.failure; this.sent.push(bytes); }
  async close(): Promise<void> {}
}
