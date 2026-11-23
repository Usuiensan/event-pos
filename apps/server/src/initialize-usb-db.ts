import { buildCatalog, writeCatalog } from "@event-pos/catalog-config";
import { exportEventCatalog, type EventCatalog } from "@event-pos/contracts";
import { synchronizeCatalogStaff } from "./business-store.js";
import { openDatabase, saveCatalog } from "./db.js";

type UsbSetup = {
  eventId: string;
  eventName: string;
  businessDate: string;
  circleName: string;
  space: string;
  receiptIssuerName: string;
};

export async function initializeUsbDatabase(dbPath: string, configPath: string, setup: UsbSetup): Promise<void> {
  const { eventId, eventName, businessDate, circleName, space, receiptIssuerName } = setup;
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(eventId)) throw new Error("イベントIDの形式が不正です。");
  const date = new Date(businessDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate) || !Number.isFinite(+date) || date.toISOString().slice(0, 10) !== businessDate) {
    throw new Error("営業日は実在する日付をYYYY-MM-DDで入力してください。");
  }
  if (!eventName || !circleName) throw new Error("イベント名とサークル名は必須です。");

  const catalog: EventCatalog = {
    eventId,
    event: {
      name: eventName,
      businessDate,
      seller: { circleName, space, receiptIssuerName: receiptIssuerName || circleName },
      locale: { language: "ja-JP", currency: "JPY", timezone: "Asia/Tokyo" },
    },
    products: [],
    quickEntries: [],
    productTabs: [{ id: "general", label: "商品" }],
    staffMembers: [{ responsibleNumber: "001", displayName: "管理者", role: "admin" }],
    customerWelcome: { circleName, space, message: "いらっしゃいませ" },
  };
  await writeCatalog(configPath, catalog);
  const verified = await buildCatalog(configPath);
  const db = openDatabase(dbPath);
  try {
    saveCatalog(db, eventId, exportEventCatalog(verified), "usb_kit_setup");
    synchronizeCatalogStaff(db, verified);
  } finally {
    db.close();
  }
}
