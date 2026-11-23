import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildCatalog } from "@event-pos/catalog-config";
import { expect, test } from "vitest";
import { initializeUsbDatabase } from "./initialize-usb-db.js";

test("USB初回設定で空の商品一覧と管理者を初期化する", async () => {
  const root = await mkdtemp(join(tmpdir(), "event-pos-usb-setup-"));
  const dbPath = join(root, "event-pos.sqlite");
  const config = join(root, "usb-kit-initial");
  try {
    await initializeUsbDatabase(dbPath, config, {
      eventId: "usb-test", eventName: "試験イベント", businessDate: "2026-11-23",
      circleName: "試験サークル", space: "", receiptIssuerName: "",
    });
    const catalog = await buildCatalog(config);
    expect(catalog.products).toEqual([]);
    expect(catalog.event?.seller.receiptIssuerName).toBe("試験サークル");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const admin = db.prepare("SELECT responsible_number, role FROM event_staff_assignments WHERE event_id = ?").get(catalog.eventId);
      expect(admin).toEqual({ responsible_number: "001", role: "admin" });
      expect(db.prepare("SELECT event_id FROM event_catalogs").get()).toEqual({ event_id: catalog.eventId });
    } finally {
      db.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
