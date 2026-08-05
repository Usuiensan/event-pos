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
    let offset = 0;
    try {
      offset = await this.session.write(bytes, (writtenOffset, bytesWritten) => this.onWrite?.(writtenOffset, bytesWritten));
      return { acceptedBytes: offset, transportEvidence: { adapter: "linux-raw", devicePath: this.devicePath, acceptedBytes: offset } };
    } catch (error) {
      this.onWrite?.(offset, 0, error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : error instanceof Error ? error.message : String(error));
      await this.close();
      throw new TransportSendError(error instanceof Error ? error.message : "printer write failed", offset, offset === 0);
    }
  }
  async close(): Promise<void> {
    await this.session.close();
  }
}
