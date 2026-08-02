import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { statusObservation, type PrinterTransport, type PrinterStatus, type SendReceipt } from "./transport.js";

const execFileAsync = promisify(execFile);

export type WindowsRawTransportOptions = { printerName: string; rawPrintScript?: string };

const bundledRawPrintScript = fileURLToPath(new URL("../scripts/windows-raw-spooler.ps1", import.meta.url));

export class WindowsRawTransport implements PrinterTransport {
  constructor(private readonly options: WindowsRawTransportOptions) {}
  async getStatus() {
    if (process.platform !== "win32") return statusObservation("unknown", { adapter: "windows-raw", reason: "Windows以外で実行" });
    try {
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", `(Get-Printer -Name ${quotePs(this.options.printerName)}).PrinterStatus`], { windowsHide: true });
      const raw = String(result.stdout).trim(); return statusObservation(raw === "Normal" ? "ready" : "unknown", { adapter: "windows-raw", printerStatus: raw });
    } catch { return statusObservation("unknown", { adapter: "windows-raw", printerName: this.options.printerName }); }
  }
  async send(bytes: Uint8Array): Promise<SendReceipt> {
    if (process.platform !== "win32") throw new Error("WindowsRawTransport requires Windows");
    const dir = await mkdtemp(join(tmpdir(), "event-pos-printer-"));
    const path = join(dir, "job.bin");
    try {
      await writeFile(path, bytes);
      const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", this.options.rawPrintScript ?? bundledRawPrintScript, "-PrinterName", this.options.printerName, "-Path", path, "-DocumentName", "event-pos print job"], { windowsHide: true, maxBuffer: 1024 * 1024 });
      const receipt = JSON.parse(String(result.stdout)) as { acceptedBytes?: unknown };
      if (!Number.isSafeInteger(receipt.acceptedBytes) || Number(receipt.acceptedBytes) < 0 || Number(receipt.acceptedBytes) > bytes.length) throw new Error("RAW spooler returned invalid acceptedBytes");
      return { acceptedBytes: Number(receipt.acceptedBytes), transportEvidence: { adapter: "windows-raw-spooler", printerName: this.options.printerName, acceptedBytes: Number(receipt.acceptedBytes) } };
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {}
}

function quotePs(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
