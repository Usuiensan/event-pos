import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type PosDatabase } from "./db.js";
import { listUnregisteredProducts, recordProvisionalProductScan } from "./provisional-products.js";

const databases: PosDatabase[] = [];
afterEach(() => { while (databases.length) databases.pop()!.close(); });

describe("未登録商品仮登録", () => {
  it("同じJANの価格を更新し、管理画面向け候補を集約する", () => {
    const database = openDatabase(); databases.push(database);
    recordProvisionalProductScan(database, { eventId: "event-1", productCode: "4901234567890", name: "未登録商品 4901234567890", priceInclTax: 1200, taxRate: 10, actorId: "staff-1" });
    recordProvisionalProductScan(database, { eventId: "event-1", productCode: "4901234567890", name: "未登録商品 4901234567890", priceInclTax: 1280, taxRate: 8, actorId: "staff-2" });
    expect(listUnregisteredProducts(database, "event-1")).toEqual([expect.objectContaining({ productCode: "4901234567890", priceInclTax: 1280, taxRate: 8, scanCount: 2, lastActorId: "staff-2" })]);
    expect(database.prepare("SELECT provisional FROM event_products WHERE event_id=? AND product_code=?").get("event-1", "4901234567890")).toMatchObject({ provisional: 1 });
  });
});
