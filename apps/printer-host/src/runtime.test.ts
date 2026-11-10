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
    expect(() => resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PRINTER_STATUS_BACKEND: "opos" })).toThrow("PRINTER_OPOS_LOGICAL_NAME");
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PRINTER_STATUS_BACKEND: "opos", PRINTER_OPOS_LOGICAL_NAME: "TM-T70II", PRINTER_OPOS_CLAIM_TIMEOUT_MS: "3000" })).toMatchObject({ windowsStatusBackend: "opos", oposLogicalName: "TM-T70II", oposClaimTimeoutMs: 3000 });
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "linux-raw", PRINTER_DEVICE: "/dev/event-pos-receipt" })).toMatchObject({ backend: "linux-raw", printerDevice: "/dev/event-pos-receipt" });
    expect(() => resolvePrinterHostRuntime({ PRINTER_BACKEND: "bridge" })).toThrow("PRINTER_BRIDGE_URL");
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "bridge", PRINTER_BRIDGE_URL: "http://127.0.0.1:4319/", PRINTER_BRIDGE_TOKEN: "secret" })).toMatchObject({ backend: "bridge", printerBridgeUrl: "http://127.0.0.1:4319/", printerBridgeToken: "secret" });
  });

  it("Windows DLE EOT status backendに既定のUSB IDを設定する", () => {
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PRINTER_STATUS_BACKEND: "dle-eot" })).toMatchObject({ windowsStatusBackend: "dle-eot", printerUsbVendorId: 0x04b8, printerUsbProductId: 0x0202 });
  });

  it("Windows DLE EOTでもUSB IDの範囲を検証する", () => {
    expect(() => resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PRINTER_STATUS_BACKEND: "dle-eot", PRINTER_USB_VENDOR_ID: "65536" })).toThrow("USB vendor/product IDは0〜65535の整数で指定してください");
  });

  it("Windows DLE EOTへUSB serial numberを伝播する", () => {
    expect(resolvePrinterHostRuntime({ PRINTER_BACKEND: "windows-spooler", PRINTER_NAME: "TM-T70II", PRINTER_STATUS_BACKEND: "dle-eot", PRINTER_USB_SERIAL_NUMBER: "ABC123" })).toMatchObject({ windowsStatusBackend: "dle-eot", printerUsbSerialNumber: "ABC123" });
  });
});
