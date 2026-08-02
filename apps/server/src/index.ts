import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { HttpPrinterHostClient } from "./printer-host-client.js";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const databasePath = process.env.POS_DATABASE_PATH ?? "./data/event-pos.sqlite";
const errorReportDirectory = process.env.POS_ERROR_REPORT_DIR ?? join(dirname(databasePath), "error-reports");
const printerHostUrl = process.env.PRINTER_HOST_URL;
const requireCashAuth = process.env.POS_REQUIRE_CASH_AUTH === "1" || process.env.POS_REQUIRE_CASH_AUTH === "true";
const app = buildApp({ database: openDatabase(databasePath), requireCashAuth, errorReportDirectory, ...(printerHostUrl ? { printerHost: new HttpPrinterHostClient(printerHostUrl) } : {}) });
const registerWebDist = process.env.REGISTER_WEB_DIST ?? "/app/register-web";
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
const sendAsset = async (file: string, reply: { type(value: string): { send(value: Buffer): unknown }; code(value: number): { send(value: unknown): unknown } }) => {
  try { const path = join(registerWebDist, file === "index.html" ? "index.html" : file); const data = await readFile(path); return reply.type(contentTypes[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream").send(data); }
  catch { return reply.code(404).send({ error: "not_found" }); }
};
app.get("/", async (_request, reply) => sendAsset("index.html", reply));
app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => sendAsset(`assets/${basename(request.params.file)}`, reply));
app.get<{ Params: { file: string } }>("/audio/:file", async (request, reply) => sendAsset(`audio/${basename(request.params.file)}`, reply));
app.get<{ Params: { speakerId: string; file: string } }>("/audio/speaker/:speakerId/:file", async (request, reply) => sendAsset(`audio/speaker/${basename(request.params.speakerId)}/${basename(request.params.file)}`, reply));
app.get<{ Params: { speakerId: string; file: string } }>("/audio/yen/:speakerId/:file", async (request, reply) => sendAsset(`audio/yen/${basename(request.params.speakerId)}/${basename(request.params.file)}`, reply));
await app.listen({ port, host });
