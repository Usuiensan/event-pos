import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { HttpPrinterHostClient } from "./printer-host-client.js";
import { readFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { productionArtifactConfig } from "./artifact-config.js";
import { activateReceiptTemplate, createReceiptTemplateDraft, validateReceiptTemplateVersion, type ReceiptTemplateRecord } from "./receipt-store.js";
import { ensureTrainingConfigDirectory, resolveTrainingCatalog, seedTrainingDatabase } from "./training-bootstrap.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const trainingMode = process.env.POS_TRAINING_MODE === "1" || process.env.POS_TRAINING_MODE === "true";
const databasePath = trainingMode ? ":memory:" : process.env.POS_DATABASE_PATH ?? "./data/event-pos.sqlite";
const trainingSourceUrl = process.env.POS_TRAINING_SOURCE_URL;
const trainingEventId = process.env.POS_TRAINING_EVENT_ID ?? "demo-event-large";
const errorReportDirectory = process.env.POS_ERROR_REPORT_DIR ?? join(dirname(databasePath), "error-reports");
const artifactConfig = productionArtifactConfig(databasePath, process.env.POS_ARTIFACT_ROOT, process.env.NODE_ENV);
const printerHostUrl = process.env.PRINTER_HOST_URL;
const requireAuth = process.env.POS_REQUIRE_AUTH !== "0" && process.env.POS_REQUIRE_AUTH !== "false";
const drawerEnabled = process.env.DRAWER_ENABLED === "1" || process.env.DRAWER_ENABLED === "true";
const eventConfigDirectory = process.env.POS_EVENT_CONFIG_DIR;
const eventConfigRepository = process.env.POS_EVENT_CONFIG_REPOSITORY;
const tlsCertPath = process.env.POS_TLS_CERT_PATH; const tlsKeyPath = process.env.POS_TLS_KEY_PATH;
if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) throw new Error("POS_TLS_CERT_PATHとPOS_TLS_KEY_PATHは両方指定してください");
if ((process.env.POS_REQUIRE_HTTPS === "1" || process.env.POS_REQUIRE_HTTPS === "true") && !tlsCertPath) throw new Error("本番HTTPSが必須ですがTLS証明書が指定されていません");
const https = tlsCertPath && tlsKeyPath ? { cert: await readFile(tlsCertPath), key: await readFile(tlsKeyPath) } : undefined;
const database = openDatabase(databasePath);
let effectiveEventConfigDirectory = eventConfigDirectory;
if (trainingMode) {
  const trainingCatalog = await resolveTrainingCatalog({ trainingEventId, ...(trainingSourceUrl ? { trainingSourceUrl } : {}), ...(eventConfigDirectory ? { eventConfigDirectory } : {}) });
  effectiveEventConfigDirectory = await ensureTrainingConfigDirectory(trainingCatalog, eventConfigDirectory);
  seedTrainingDatabase(database, trainingCatalog);
  if (trainingSourceUrl) {
    try {
      const response = await fetch(`${trainingSourceUrl.replace(/\/$/, "")}/api/v1/receipt-templates`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { templates } = await response.json() as { templates: ReceiptTemplateRecord[] };
      const active = templates.filter((template) => template.templateKey === "sale-receipt" && template.status === "active").sort((a, b) => b.version - a.version)[0];
      if (active) {
        const draft = createReceiptTemplateDraft(database, { templateKey: "sale-receipt", sourceText: active.sourceText, assets: active.assets });
        const validated = validateReceiptTemplateVersion(database, "sale-receipt", draft.version);
        activateReceiptTemplate(database, "sale-receipt", draft.version, validated.validatedSourceSha256 ?? validated.sourceSha256);
      }
    } catch (error) {
      console.warn(`トレーニング用レシートテンプレートの同期に失敗しました（デフォルトで継続）: ${error instanceof Error ? error.message : error}`);
    }
  }
}
const app = buildApp({ database, requireAuth, drawerEnabled, errorReportDirectory, artifactRoot: artifactConfig.artifactRoot, artifactMinimumFreeBytes: artifactConfig.minimumFreeBytes, ...(effectiveEventConfigDirectory ? { eventConfigDirectory: effectiveEventConfigDirectory } : {}), ...(eventConfigRepository ? { eventConfigRepository } : {}), ...(https ? { https } : {}), ...(printerHostUrl ? { printerHost: new HttpPrinterHostClient(printerHostUrl) } : {}) });
const registerWebDist = process.env.REGISTER_WEB_DIST ?? "/app/register-web";
const contentTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav", ".mp3": "audio/mpeg" };
const sendAsset = async (file: string, reply: { type(value: string): { send(value: Buffer): unknown }; code(value: number): { send(value: unknown): unknown } }) => {
  try { const path = join(registerWebDist, file === "index.html" ? "index.html" : file); let data = await readFile(path); if (file === "index.html" && trainingMode) data = Buffer.from(data.toString("utf8").replace("</head>", "<script>window.__POS_TRAINING__=true;</script></head>"), "utf8"); return reply.type(contentTypes[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream").send(data); }
  catch { return reply.code(404).send({ error: "not_found" }); }
};
app.get("/", async (_request, reply) => sendAsset("index.html", reply));
app.get("/manifest.webmanifest", async (_request, reply) => sendAsset("manifest.webmanifest", reply));
app.get("/sw.js", async (_request, reply) => sendAsset("sw.js", reply));
app.get<{ Params: { file: string } }>("/icons/:file", async (request, reply) => sendAsset(`icons/${basename(request.params.file)}`, reply));
app.get<{ Params: { file: string } }>("/assets/:file", async (request, reply) => sendAsset(`assets/${basename(request.params.file)}`, reply));
app.get<{ Params: { file: string } }>("/audio/:file", async (request, reply) => sendAsset(`audio/${basename(request.params.file)}`, reply));
app.get<{ Params: { speakerId: string; file: string } }>("/audio/speaker/:speakerId/:file", async (request, reply) => sendAsset(`audio/speaker/${basename(request.params.speakerId)}/${basename(request.params.file)}`, reply));
app.get<{ Params: { speakerId: string; file: string } }>("/audio/yen/:speakerId/:file", async (request, reply) => sendAsset(`audio/yen/${basename(request.params.speakerId)}/${basename(request.params.file)}`, reply));
await app.listen({ port, host });
