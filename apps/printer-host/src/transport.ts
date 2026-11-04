import type { PrintJob, PrinterStatusObservation } from "@event-pos/contracts";
import { bytesSha256, canonicalIrToEscPos, ESCPOS_RENDERER_VERSION_ROTATE180 } from "@event-pos/escpos";

export type PrinterStatus = "ready" | "paper_out" | "offline" | "unknown";
export type SendReceipt = { acceptedBytes: number; transportEvidence: Record<string, string | number | boolean> };
export type PrinterTransport = {
  statusPollingSharesTransport?: boolean;
  getStatus(): Promise<PrinterStatusObservation>;
  send(bytes: Uint8Array): Promise<SendReceipt>;
  close(): Promise<void>;
};

export function statusObservation(status: PrinterStatus, raw: unknown = status): PrinterStatusObservation {
  const unknown = (reason: string) => ({ support: "unknown" as const, reason });
  const base = { observedAt: new Date().toISOString(), coverOpen: unknown("この接続方式では未取得"), drawerOpen: unknown("この接続方式では未取得"), paper: unknown("この接続方式では未取得"), error: unknown("この接続方式では未取得"), raw };
  if (status === "ready") return { ...base, reachable: { support: "supported", value: true }, online: { support: "supported", value: true } };
  if (status === "offline") return { ...base, reachable: { support: "supported", value: false }, online: unknown("offlineの詳細は未取得") };
  if (status === "paper_out") return { ...base, reachable: { support: "supported", value: true }, online: unknown("紙切れ時のonlineは未取得"), paper: { support: "supported", value: "empty" } };
  return { ...base, reachable: unknown("状態取得不能"), online: unknown("状態取得不能") };
}

export class TransportSendError extends Error {
  constructor(message: string, public readonly acceptedBytes: number, public readonly notSentProven: boolean, public readonly retryable = notSentProven && acceptedBytes === 0) { super(message); }
}

export function renderEscPos(job: PrintJob): Uint8Array {
  if (job.documentType === "drawer") {
    const payload = job.payload as { pin?: unknown; onMs?: unknown; offMs?: unknown };
    // BC-415M-B(6C) diagnostics: only fixed profiles are allowed.
    const profiles = new Map<string, number[]>([
      ["2:4:40", [0x1b, 0x70, 0x00, 0x02, 0x14]],
      ["2:40:200", [0x1b, 0x70, 0x00, 0x14, 0x64]],
      ["2:80:400", [0x1b, 0x70, 0x00, 0x28, 0xc8]],
      ["5:40:200", [0x1b, 0x70, 0x01, 0x14, 0x64]],
      ["5:80:400", [0x1b, 0x70, 0x01, 0x28, 0xc8]],
    ]);
    const bytes = profiles.get(`${String(payload?.pin)}:${String(payload?.onMs)}:${String(payload?.offMs)}`);
    if (!bytes) throw new Error("approved drawer pulse profile is required");
    return Uint8Array.from(bytes);
  }
  if (job.documentType === "receipt") {
    if (!job.canonicalIr || !job.bytesSha256 || !job.irSha256 || !job.expectedBytesLength || !job.rendererVersion || !job.templateKey || !job.templateVersion || !job.templateSourceSha256 || !job.fontId || !job.fontVersion || !job.fontSha256 || !job.finishingPolicyId || !job.finishingPolicyVersion) throw new Error("receipt version metadata is required");
    const bytes = canonicalIrToEscPos(job.canonicalIr, job.assets ?? [], { rotate180: job.rendererVersion === ESCPOS_RENDERER_VERSION_ROTATE180 });
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
  async getStatus(): Promise<PrinterStatusObservation> { return statusObservation(this.status); }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    if (this.failure) throw this.failure;
    const acceptedBytes = this.acceptedBytes ?? bytes.length;
    if (acceptedBytes > 0) this.sent.push(bytes.slice(0, acceptedBytes));
    return { acceptedBytes, transportEvidence: { adapter: "fake", acceptedBytes } };
  }
  async close(): Promise<void> {}
}
