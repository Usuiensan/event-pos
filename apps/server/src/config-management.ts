import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance, FastifyReply } from "fastify";
import { buildCatalog, writeCatalog } from "@event-pos/catalog-config";
import { exportEventCatalog, importEventCatalog, type EventCatalog } from "@event-pos/contracts";
import { getCatalog, saveCatalog, type PosDatabase } from "./db.js";
import { getOpenBusinessSession, synchronizeCatalogStaff } from "./business-store.js";
import { AuthError, requireAuthActor } from "./auth.js";

const exec = promisify(execFile);
export type ConfigManagementOptions = { database: PosDatabase; configDirectory?: string; configRepository?: string; authRequired: boolean };

function failure(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof AuthError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: {}, requestId: reply.request.id } });
  const message = error instanceof Error ? error.message : "設定を保存できません";
  const status = /営業中|CONFIG_GIT_DIRTY/.test(message) ? 409 : 400;
  return reply.code(status).send({ error: { code: "CONFIG_SAVE_FAILED", message, details: {}, requestId: reply.request.id } });
}

async function assertClean(repository: string, configDirectory: string): Promise<void> {
  const relative = configDirectory.replace(/\\/g, "/").replace(`${repository.replace(/\\/g, "/")}/`, "");
  const { stdout } = await exec("git", ["status", "--porcelain", "--", relative], { cwd: repository });
  if (stdout.trim()) throw new Error("CONFIG_GIT_DIRTY: 設定YAMLに未コミットの変更があるため保存できません");
}

async function commitConfig(repository: string, configDirectory: string, actor: string): Promise<string> {
  const relative = configDirectory.replace(/\\/g, "/").replace(`${repository.replace(/\\/g, "/")}/`, "");
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

  app.put<{ Params: { eventId: string }; Body: { catalog: EventCatalog } }>("/api/v1/events/:eventId/management-config", async (request, reply) => {
    try {
      const actor = requireAuthActor(options.database, request, "manager", options.authRequired);
      if (!options.configDirectory) throw new Error("POS_EVENT_CONFIG_DIRが設定されていません");
      if (getOpenBusinessSession(options.database, request.params.eventId)) throw new Error("営業中は設定を保存できません");
      const catalog = importEventCatalog(JSON.stringify(request.body?.catalog));
      if (catalog.eventId !== request.params.eventId || actor.eventId !== catalog.eventId) throw new Error("eventIdが一致しません");
      if (options.configRepository) await assertClean(options.configRepository, options.configDirectory);
      await writeCatalog(options.configDirectory, catalog);
      const verified = await buildCatalog(options.configDirectory);
      const record = saveCatalog(options.database, verified.eventId, exportEventCatalog(verified));
      synchronizeCatalogStaff(options.database, verified);
      const commitId = options.configRepository ? await commitConfig(options.configRepository, options.configDirectory, actor.responsibleNumber) : undefined;
      options.database.prepare("INSERT INTO audit_log(event_id,action,entity_type,entity_id,detail_json,created_at) VALUES (?,'management_config_saved','event_catalog',?,?,?)").run(verified.eventId, verified.eventId, JSON.stringify({ actorId: actor.staffId, responsibleNumber: actor.responsibleNumber, gitCommitId: commitId ?? null }), new Date().toISOString());
      return { catalog: verified, updatedAt: record.updatedAt, gitCommitId: commitId ?? null };
    } catch (error) { return failure(reply, error); }
  });
}
