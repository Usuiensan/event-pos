import type { PrintJob } from "@event-pos/contracts";
import { bytesSha256, canonicalIrToEscPos } from "@event-pos/escpos";

export type PrinterStatus = "ready" | "paper_out" | "offline" | "unknown";
export type SendReceipt = { acceptedBytes: number };
export type PrinterTransport = {
  getStatus(): Promise<PrinterStatus>;
  send(bytes: Uint8Array): Promise<SendReceipt>;
  close(): Promise<void>;
};

export class TransportSendError extends Error {
  constructor(message: string, public readonly acceptedBytes: number, public readonly notSentProven: boolean, public readonly retryable = notSentProven && acceptedBytes === 0) { super(message); }
}

export function renderEscPos(job: PrintJob): Uint8Array {
  if (job.documentType === "receipt") {
    if (!job.canonicalIr || !job.bytesSha256 || !job.irSha256 || !job.expectedBytesLength || !job.rendererVersion || !job.templateKey || !job.templateVersion || !job.templateSourceSha256 || !job.fontId || !job.fontVersion || !job.fontSha256 || !job.finishingPolicyId || !job.finishingPolicyVersion) throw new Error("receipt version metadata is required");
    const bytes = canonicalIrToEscPos(job.canonicalIr, job.assets ?? []);
    if (bytesSha256(bytes) !== job.bytesSha256 || bytes.length !== job.expectedBytesLength) throw new Error("receipt bytes hash mismatch");
    return bytes;
  }
  const payload = job.payload as { escposBase64?: unknown };
  if (payload && typeof payload === "object" && typeof payload.escposBase64 === "string" && job.source && job.rendererVersion) {
    const bytes = Uint8Array.from(Buffer.from(payload.escposBase64, "base64"));
    if (job.bytesSha256 && bytesSha256(bytes) !== job.bytesSha256) throw new Error("external bytes hash mismatch");
    return bytes;
  }
  throw new Error("approved renderer output is required");
}

export class FakeTransport implements PrinterTransport {
  readonly sent: Uint8Array[] = [];
  constructor(private readonly failure?: Error, private readonly status: PrinterStatus = failure ? "unknown" : "ready", private readonly acceptedBytes?: number) {}
  async getStatus(): Promise<PrinterStatus> { return this.status; }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    if (this.failure) throw this.failure;
    const acceptedBytes = this.acceptedBytes ?? bytes.length;
    if (acceptedBytes > 0) this.sent.push(bytes.slice(0, acceptedBytes));
    return { acceptedBytes };
  }
  async close(): Promise<void> {}
}
