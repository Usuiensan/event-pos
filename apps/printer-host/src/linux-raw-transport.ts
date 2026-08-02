import { open, type FileHandle } from "node:fs/promises";
import { TransportSendError, type PrinterStatus, type PrinterTransport, type SendReceipt } from "./transport.js";

/** Linux RAW USB transport skeleton. Device/status behavior remains hardware-gated. */
export class LinuxRawTransport implements PrinterTransport {
  private handle: FileHandle | undefined;
  constructor(private readonly devicePath: string, private readonly statusProbe: () => Promise<PrinterStatus> = async () => "unknown") {}
  async getStatus(): Promise<PrinterStatus> {
    try { return await this.statusProbe(); } catch { return "unknown"; }
  }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    this.handle ??= await open(this.devicePath, "w");
    let offset = 0;
    try {
      while (offset < bytes.byteLength) {
        const result = await this.handle.write(bytes, offset, bytes.byteLength - offset);
        if (result.bytesWritten <= 0) throw new Error("printer write made no progress");
        offset += result.bytesWritten;
      }
      return { acceptedBytes: offset };
    } catch (error) {
      await this.close();
      throw new TransportSendError(error instanceof Error ? error.message : "printer write failed", offset, offset === 0);
    }
  }
  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
}
