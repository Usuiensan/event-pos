import { open, type FileHandle } from "node:fs/promises";
import type { PrinterStatus, PrinterTransport } from "./transport.js";

/** Linux RAW USB transport skeleton. Device/status behavior remains hardware-gated. */
export class LinuxRawTransport implements PrinterTransport {
  private handle: FileHandle | undefined;
  constructor(private readonly devicePath: string) {}
  async getStatus(): Promise<PrinterStatus> {
    return "unknown";
  }
  async send(bytes: Uint8Array): Promise<void> {
    this.handle ??= await open(this.devicePath, "w");
    await this.handle.write(bytes);
  }
  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = undefined;
  }
}
