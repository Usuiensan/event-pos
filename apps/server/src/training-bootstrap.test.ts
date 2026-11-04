import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCatalog } from "@event-pos/catalog-config";
import { getCatalog, openDatabase } from "./db.js";
import { ensureTrainingConfigDirectory, seedTrainingDatabase } from "./training-bootstrap.js";

const catalogDirectory = resolve(import.meta.dirname, "../../../event-config/demo");

describe("トレーニング起動", () => {
  it("設定ディレクトリを一時生成してカタログを往復できる", async () => {
    const catalog = await buildCatalog(catalogDirectory);
    const directory = await ensureTrainingConfigDirectory(catalog);
    expect(await buildCatalog(directory)).toEqual(catalog);
  });

  it("明示された設定ディレクトリはそのまま返し、書き込まない", async () => {
    const catalog = await buildCatalog(catalogDirectory);
    const directory = resolve("/tmp/event-pos-training-test-missing");
    expect(await ensureTrainingConfigDirectory(catalog, directory)).toBe(directory);
    expect(existsSync(directory)).toBe(false);
  });

  it("カタログとスタッフだけをseedし、営業・レジを自動開局しない", async () => {
    const catalog = await buildCatalog(catalogDirectory);
    const database = openDatabase(":memory:");
    try {
      seedTrainingDatabase(database, catalog);
      expect(getCatalog(database, catalog.eventId)?.eventId).toBe(catalog.eventId);
      expect(database.prepare("SELECT COUNT(*) AS count FROM business_sessions").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM cash_sessions").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });
});
