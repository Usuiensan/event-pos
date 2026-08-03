import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildCatalog, writeCatalog } from "@event-pos/catalog-config";
import { exportEventCatalog, importEventCatalog, type EventCatalog } from "@event-pos/contracts";
import { getCatalog, saveCatalog, type PosDatabase } from "./db.js";
import { getOpenBusinessSession, synchronizeCatalogStaff } from "./business-store.js";
import { AuthError, requireAuthActor } from "./auth.js";
import { loadGs1CompanyPrefixRegistry } from "./gs1-registry.js";
import { fetchIsdnProduct } from "./isdn.js";
import { fetchNdlIsbnProduct } from "./isbn.js";
import { lookupProductCandidates, recordProductLookupAdoption } from "./product-lookup.js";

const exec = promisify(execFile);
export type ConfigManagementOptions = { database: PosDatabase; configDirectory?: string; configRepository?: string; authRequired: boolean };

function failure(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AuthError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: {}, requestId: reply.request.id } });
  const message = error instanceof Error ? error.message : "設定を保存できません";
  const status = /営業中/.test(message) ? 409 : 400;
  return reply.code(status).send({ error: { code: "CONFIG_SAVE_FAILED", message, details: {}, requestId: reply.request.id } });
}

function configPath(repository: string, configDirectory: string): string {
  const relative = configDirectory.replace(/\\/g, "/").replace(`${repository.replace(/\\/g, "/")}/`, "");
  return relative;
}

async function hasConfigChanges(repository: string, configDirectory: string): Promise<boolean> {
  const relative = configPath(repository, configDirectory);
  const { stdout } = await exec("git", ["status", "--porcelain", "--", relative], { cwd: repository });
  return Boolean(stdout.trim());
}

async function commitConfig(repository: string, configDirectory: string, actor: string): Promise<string | undefined> {
  const relative = configPath(repository, configDirectory);
  if (!(await hasConfigChanges(repository, configDirectory))) return undefined;
  await exec("git", ["add", "--", relative], { cwd: repository });
  await exec("git", ["commit", "--only", "-m", `管理画面からPOS設定を更新 (${actor})`, "--", relative], { cwd: repository });
  const { stdout } = await exec("git", ["rev-parse", "HEAD"], { cwd: repository });
  return stdout.trim();
}

export function registerConfigManagementRoutes(app: FastifyInstance, options: ConfigManagementOptions): void {
  app.get<{ Params: { eventId: string } }>("/api/v1/events/:eventId/management-config", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired);
      const record = getCatalog(options.database, request.params.eventId);
      if (!record) return reply.code(404).send({ error: { code: "CATALOG_NOT_FOUND", message: "設定が見つかりません", details: {}, requestId: request.id } });
      return { catalog: importEventCatalog(record.catalogJson), businessOpen: Boolean(getOpenBusinessSession(options.database, request.params.eventId)) };
    } catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { eventId: string } }>("/api/v1/events/:eventId/gs1-company-prefixes", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired);
      if (!options.configDirectory) throw new Error("POS_EVENT_CONFIG_DIRが設定されていません");
      const registry = await loadGs1CompanyPrefixRegistry(options.configDirectory);
      return { registry };
    } catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { code: string } }>("/api/v1/isdn/:code", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired);
      if (!/^\d{13}$/.test(request.params.code) || !request.params.code.startsWith("278")) return reply.code(400).send({ error: { code: "INVALID_ISDN", message: "ISDNは278で始まる13桁の番号です", details: {}, requestId: request.id } });
      return { info: await fetchIsdnProduct(request.params.code) };
    } catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { code: string } }>("/api/v1/isbn/:code", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "manager", options.authRequired);
      if (!/^97[89]\d{10}$/.test(request.params.code)) return reply.code(400).send({ error: { code: "INVALID_ISBN", message: "ISBNは978または979で始まる13桁の番号です", details: {}, requestId: request.id } });
      return { info: await fetchNdlIsbnProduct(request.params.code) };
    } catch (error) { return failure(reply, error); }
  });

  app.get<{ Params: { eventId: string; code: string } }>("/api/v1/events/:eventId/product-lookup/:code", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "manager", options.authRequired);
      if (actor.eventId !== request.params.eventId) throw new Error("eventIdが一致しません");
      return await lookupProductCandidates(options.database, request.params.eventId, options.configDirectory, request.params.code);
    } catch (error) { return failure(reply, error); }
  });

  app.post<{ Params: { eventId: string }; Body: { productCode?: string; fieldName?: string; candidate?: unknown } }>("/api/v1/events/:eventId/product-lookup/adoptions", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "manager", options.authRequired);
      const allowedFields = new Set(["name", "seller", "manufacturer", "brand", "producer", "specification"]);
      if (actor.eventId !== request.params.eventId || !request.body?.productCode || !request.body.fieldName || !allowedFields.has(request.body.fieldName) || !request.body.candidate || typeof request.body.candidate !== "object") throw new Error("候補採用情報が不正です");
      recordProductLookupAdoption(options.database, request.params.eventId, request.body.productCode, request.body.fieldName, request.body.candidate as never, actor.staffId);
      return { recorded: true };
    } catch (error) { return failure(reply, error); }
  });

  app.put<{ Params: { eventId: string }; Body: { catalog: EventCatalog } }>("/api/v1/events/:eventId/management-config", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "manager", options.authRequired);
      if (!options.configDirectory) throw new Error("POS_EVENT_CONFIG_DIRが設定されていません");
      if (getOpenBusinessSession(options.database, request.params.eventId)) throw new Error("営業中は設定を保存できません");
      const catalog = importEventCatalog(JSON.stringify(request.body?.catalog));
      if (catalog.eventId !== request.params.eventId || actor.eventId !== catalog.eventId) throw new Error("eventIdが一致しません");
      await writeCatalog(options.configDirectory, catalog);
      const verified = await buildCatalog(options.configDirectory);
      const commitId = options.configRepository ? await commitConfig(options.configRepository, options.configDirectory, actor.responsibleNumber) : undefined;
      const record = saveCatalog(options.database, verified.eventId, exportEventCatalog(verified));
      synchronizeCatalogStaff(options.database, verified);
      options.database.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'management_config_saved','event_catalog',?,?,?)").run(verified.eventId, verified.eventId, JSON.stringify({ actorId: actor.staffId, responsibleNumber: actor.responsibleNumber, gitCommitId: commitId ?? null }), new Date().toISOString());
      return { catalog: verified, updatedAt: record.updatedAt, gitCommitId: commitId ?? null };
    } catch (error) { return failure(reply, error); }
  });
}
