import { exportEventCatalog, type EventCatalog } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import { saveCatalog } from "./db.js";
import { synchronizeCatalogStaff } from "./business-store.js";

export function initializeTrainingDatabase(database: PosDatabase, catalog: EventCatalog): void {
  saveCatalog(database, catalog.eventId, exportEventCatalog(catalog), "training_seed");
  synchronizeCatalogStaff(database, catalog);
}
