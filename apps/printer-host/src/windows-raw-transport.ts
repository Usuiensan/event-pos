import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrinterTransport, PrinterStatus } from "./transport.js";

const execFileAsync = promisify(execFile);

export type WindowsRawTransportOptions = { printerName: string; rawPrintScript: string };

export class WindowsRawTransport implements PrinterTransport {
  constructor(private readonly options: WindowsRawTransportOptions) {}
  async getStatus(): Promise<PrinterStatus> {
    if (process.platform !== "win32") return "unknown";
    try {
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `(Get-Printer -Name ${quotePs(this.options.printerName)}).PrinterStatus`], { windowsHide: true });
      return String(result.stdout).trim() === "Normal" ? "ready" : "unknown";
    } catch { return "unknown"; }
  }
  async send(bytes: Uint8Array): Promise<void> {
    if (process.platform !== "win32") throw new Error("WindowsRawTransport requires Windows");
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-"));
    const path = join(dir, "job.bin");
    try {
      await writeFile(path, bytes);
      await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.options.rawPrintScript, "-PrinterName", this.options.printerName, "-Path", path, "-DocumentName", "event-pos print job"], { windowsHide: true, maxBuffer: 1024 * 1024 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {}
}

function quotePs(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
