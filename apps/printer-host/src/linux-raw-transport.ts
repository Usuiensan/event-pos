import { open, type FileHandle } from "node:fs/promises";
import type { PrinterStatus, PrinterTransport } from "./transport.js";

/** Linux RAW USB transport skeleton. Device/status behavior remains hardware-gated. */
export class LinuxRawTransport implements PrinterTransport {
  private handle: FileHandle | undefined;
  constructor(private readonly devicePath: string, private readonly statusProbe: () => Promise<PrinterStatus> = async () => "unknown") {}
  async getStatus(): Promise<PrinterStatus> {
    try { return await this.statusProbe(); } catch { return "unknown"; }
  }
  async send(bytes: Uint8Array): Promise<void> {
    this.handle ??= await open(this.devicePath, "w");
    try {
      await this.handle.write(bytes);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
}
