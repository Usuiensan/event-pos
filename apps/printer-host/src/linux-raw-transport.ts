import type { PrinterStatusObservation } from "@event-pos/contracts";
import { statusObservation, TransportSendError, type PrinterStatus, type PrinterTransport, type SendReceipt } from "./transport.js";
import { decodeDleEot, LinuxDleEotSession } from "./linux-status-probe.js";

/** Linux RAW USB transport skeleton. Device/status behavior remains hardware-gated. */
export class LinuxRawTransport implements PrinterTransport {
  private readonly session: LinuxDleEotSession;
  constructor(private readonly devicePath: string, private readonly statusProbe?: () => Promise<PrinterStatus | { status: PrinterStatus; raw: unknown }>, private readonly onWrite?: (offset: number, bytesWritten: number, error?: string) => void, timeoutMs = 1_000, private readonly drawerOpenHigh?: boolean) { this.session = new LinuxDleEotSession(devicePath, timeoutMs); }
  async getStatus(): Promise<PrinterStatusObservation> {
    try {
      if (this.statusProbe) {
        const observation = await this.statusProbe(); const status = typeof observation === "string" ? observation : observation.status; const raw = typeof observation === "string" ? observation : observation.raw;
        return statusObservation(status, { adapter: "linux-raw", devicePath: this.devicePath, statusProbe: raw });
      }
      const raw = await this.session.query(); if (raw.some((item) => !item.responseHex)) await this.session.close(); return { ...decodeDleEot(raw, this.drawerOpenHigh), raw: { adapter: "linux-raw", devicePath: this.devicePath, statusProbe: raw } };
    } catch (error) { return statusObservation("unknown", { adapter: "linux-raw", devicePath: this.devicePath, error: error instanceof Error ? error.message : String(error) }); }
  }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    let acceptedBytes = 0;
    let notSentProven = true;
    try {
      await this.session.write(bytes, (offset, bytesWritten) => {
        acceptedBytes = offset + bytesWritten;
        notSentProven = acceptedBytes === 0;
        this.onWrite?.(offset, bytesWritten);
      }, () => { notSentProven = false; });
      return { acceptedBytes, transportEvidence: { adapter: "linux-raw", devicePath: this.devicePath, acceptedBytes } };
    } catch (error) {
      this.onWrite?.(acceptedBytes, 0, error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : error instanceof Error ? error.message : String(error));
      // Keep the write error and its delivery evidence if cleanup also fails.
      await this.close().catch(() => undefined);
      throw new TransportSendError(error instanceof Error ? error.message : "printer write failed", acceptedBytes, notSentProven);
    }
  }
  async close(): Promise<void> {
    await this.session.close();
  }
}
