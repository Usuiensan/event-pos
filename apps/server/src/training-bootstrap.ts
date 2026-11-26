import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalog, writeCatalog } from "@event-pos/catalog-config";
import { exportEventCatalog, type EventCatalog } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import { saveCatalog } from "./db.js";
import { assertStaffChangeKeepsAdmin, synchronizeCatalogStaff } from "./business-store.js";

export async function fetchTrainingCatalog(trainingSourceUrl: string, trainingEventId: string): Promise<EventCatalog> {
  const response = await fetch(`${trainingSourceUrl.replace(/\/$/, "")}/api/v1/events/${encodeURIComponent(trainingEventId)}/catalog`);
  if (!response.ok) throw new Error(`トレーニング用カタログ取得に失敗しました: HTTP ${response.status}`);
  return (await response.json() as { catalog: EventCatalog }).catalog;
}

export async function resolveTrainingCatalog(options: { trainingSourceUrl?: string; trainingEventId: string; eventConfigDirectory?: string }): Promise<EventCatalog> {
  if (options.trainingSourceUrl) return fetchTrainingCatalog(options.trainingSourceUrl, options.trainingEventId);
  if (options.eventConfigDirectory) return buildCatalog(options.eventConfigDirectory);
  throw new Error("トレーニングモードにはPOS_EVENT_CONFIG_DIRまたはPOS_TRAINING_SOURCE_URLが必要です");
}

export async function ensureTrainingConfigDirectory(catalog: EventCatalog, eventConfigDirectory?: string): Promise<string> {
  if (eventConfigDirectory) return eventConfigDirectory;
  const directory = await mkdtemp(join(tmpdir(), "event-pos-training-"));
  await writeCatalog(directory, catalog);
  return directory;
}

export function seedTrainingDatabase(database: PosDatabase, catalog: EventCatalog): void {
  assertStaffChangeKeepsAdmin(database, catalog);
  saveCatalog(database, catalog.eventId, exportEventCatalog(catalog), "training_seed");
  synchronizeCatalogStaff(database, catalog);
}
