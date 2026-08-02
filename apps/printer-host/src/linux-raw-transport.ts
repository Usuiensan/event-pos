import { open, type FileHandle } from "node:fs/promises";
import { statusObservation, TransportSendError, type PrinterStatus, type PrinterTransport, type SendReceipt } from "./transport.js";

/** Linux RAW USB transport skeleton. Device/status behavior remains hardware-gated. */
export class LinuxRawTransport implements PrinterTransport {
  private handle: FileHandle | undefined;
  constructor(private readonly devicePath: string, private readonly statusProbe: () => Promise<PrinterStatus | { status: PrinterStatus; raw: unknown }> = async () => "unknown", private readonly onWrite?: (offset: number, bytesWritten: number, error?: string) => void) {}
  async getStatus() {
    try {
      const observation = await this.statusProbe();
      const status = typeof observation === "string" ? observation : observation.status;
      const raw = typeof observation === "string" ? observation : observation.raw;
      return statusObservation(status, { adapter: "linux-raw", devicePath: this.devicePath, statusProbe: raw });
    } catch (error) { return statusObservation("unknown", { adapter: "linux-raw", devicePath: this.devicePath, error: error instanceof Error ? error.message : String(error) }); }
  }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    this.handle ??= await open(this.devicePath, "w");
    let offset = 0;
    try {
      while (offset < bytes.byteLength) {
        const result = await this.handle.write(bytes, offset, bytes.byteLength - offset);
        this.onWrite?.(offset, result.bytesWritten);
        if (result.bytesWritten <= 0) throw new Error("printer write made no progress");
        offset += result.bytesWritten;
      }
      return { acceptedBytes: offset, transportEvidence: { adapter: "linux-raw", devicePath: this.devicePath, acceptedBytes: offset } };
    } catch (error) {
      this.onWrite?.(offset, 0, error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : error instanceof Error ? error.message : String(error));
      await this.close();
      throw new TransportSendError(error instanceof Error ? error.message : "printer write failed", offset, offset === 0);
    }
  }
  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
}
