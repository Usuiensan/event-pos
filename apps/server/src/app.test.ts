import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

describe("server foundation", () => {
  it("serves live, ready, and info endpoints against SQLite", async () => {
    const app = buildApp({ database: openDatabase() });
    apps.push(app);
    expect((await app.inject("/health/live")).json()).toEqual({ status: "ok" });
    expect((await app.inject("/health/ready")).json()).toEqual({ status: "ok", database: "ok" });
    expect((await app.inject("/api/v1/info")).json()).toMatchObject({ name: "event-pos", schemaVersion: 1 });
  });
});
