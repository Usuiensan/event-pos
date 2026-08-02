import { describe, expect, it } from "vitest";
import { WindowsRawTransport } from "./windows-raw-transport.js";

describe("WindowsRawTransport", () => {
  it("does not claim readiness outside Windows", async () => {
    const transport = new WindowsRawTransport({ printerName: "test", rawPrintScript: "rawprint.ps1" });
    if (process.platform !== "win32") expect(await transport.getStatus()).toMatchObject({ reachable: { support: "unknown" }, online: { support: "unknown" } });
  });
});
