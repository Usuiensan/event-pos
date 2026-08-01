import { DatabaseSync } from "node:sqlite";

export type PosDatabase = DatabaseSync;

export function openDatabase(filename = ":memory:"): PosDatabase {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const existing = db.prepare("SELECT version FROM schema_migrations WHERE version = 1").get();
  if (!existing) {
    db.exec("BEGIN;");
    try {
      db.prepare("INSERT INTO app_metadata (key, value) VALUES (?, ?)").run("schema_version", "1");
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(1, new Date().toISOString());
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  return db;
}
