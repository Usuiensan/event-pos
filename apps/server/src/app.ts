import Fastify, { type FastifyInstance } from "fastify";
import type { PosDatabase } from "./db.js";

export type AppOptions = { database: PosDatabase };

export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onClose", async () => options.database.close());
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      options.database.prepare("SELECT 1 AS ready").get();
      return { status: "ok", database: "ok" };
    } catch {
      return reply.code(503).send({ status: "not_ready", database: "error" });
    }
  });
  app.get("/api/v1/info", async () => ({ name: "event-pos", service: "server", schemaVersion: 1 }));
  return app;
}
