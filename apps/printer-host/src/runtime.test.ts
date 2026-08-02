import { describe, expect, it } from "vitest";
import { resolvePrinterHostRuntime } from "./runtime.js";

describe("PrinterHost本番設定", () => {
  it("本番ではbackendの暗黙fake化を拒否する", () => {
    expect(() => resolvePrinterHostRuntime({ NODE_ENV: "production" })).toThrow("PRINTER_BACKEND");
  });

  it("WindowsとLinuxの必須接続先を検証する", () => {
    expect(() => resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler" })).toThrow("PRINTER_NAME");
    expect(() => resolvePrinterHostRuntime({ PRINTER_BACKEND: "linux-raw" })).toThrow("PRINTER_DEVICE");
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PORT: "4319" })).toMatchObject({ backend: "windows-spooler", printerName: "TM-T70II", port: 4319 });
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "linux-raw", PRINTER_DEVICE: "/dev/event-pos-receipt" })).toMatchObject({ backend: "linux-raw", printerDevice: "/dev/event-pos-receipt" });
  });
});
