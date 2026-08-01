import { buildPrinterHost } from "./app.js";
import { FakeTransport } from "./transport.js";
import { LinuxRawTransport } from "./linux-raw-transport.js";
import { HttpStateSink } from "./http-state-sink.js";
import { WindowsRawTransport } from "./windows-raw-transport.js";

const transport = process.env.PRINTER_BACKEND === "windows-spooler"
  ? new WindowsRawTransport({ printerName: process.env.PRINTER_NAME ?? "EPSON TM-T70II Receipt", rawPrintScript: process.env.WINDOWS_RAW_PRINT_SCRIPT ?? "C:\\private\\discord-printer-bot\\tools\\rawprint.ps1" })
  : process.env.PRINTER_DEVICE ? new LinuxRawTransport(process.env.PRINTER_DEVICE) : new FakeTransport();
const stateSink = process.env.POS_BASE_URL ? new HttpStateSink(process.env.POS_BASE_URL) : undefined;
const app = buildPrinterHost({ transport, ...(stateSink ? { stateSink } : {}) });
await app.listen({ host: process.env.HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 4318) });
