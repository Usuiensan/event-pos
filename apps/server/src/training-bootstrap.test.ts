import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { initializeTrainingDatabase } from "./training-bootstrap.js";

describe("トレーニング起動", () => {
  it("設定とスタッフだけを準備し、営業・レジを自動開局しない", () => {
    const database = openDatabase();
    try {
      initializeTrainingDatabase(database, {
        eventId: "training-event",
        products: [],
        quickEntries: [],
        staffMembers: [{ responsibleNumber: "001", displayName: "管理者", role: "admin" }],
      });

      expect(database.prepare("SELECT COUNT(*) AS count FROM business_sessions").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM cash_sessions").get()).toEqual({ count: 0 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM event_catalogs WHERE event_id='training-event'").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});
