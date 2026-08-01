import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { HttpPrinterHostClient } from "./printer-host-client.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const databasePath = process.env.POS_DATABASE_PATH ?? "./data/event-pos.sqlite";
const printerHostUrl = process.env.PRINTER_HOST_URL;
const app = buildApp({ database: openDatabase(databasePath), ...(printerHostUrl ? { printerHost: new HttpPrinterHostClient(printerHostUrl) } : {}) });
await app.listen({ port, host });
