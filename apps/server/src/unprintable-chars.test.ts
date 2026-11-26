import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { openDatabase, type PosDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

// F-070（部門名）/ F-071（商品名）: CP932で印字できない文字が、会計確定や
// 中間点検・精算のトランザクションを例外で巻き戻す欠陥の回帰テスト。
// (a) 保存時検証で新規カタログは拒否し、(b) 既存データは印字時の置換で守る。
const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const staffMembers = [
  { responsibleNumber: "001", displayName: "販売担当", role: "operator" },
  { responsibleNumber: "002", displayName: "責任者", role: "manager" },
  { responsibleNumber: "003", displayName: "管理者", role: "admin" },
];

function makeCatalog(eventId: string, overrides: { productName?: string; departmentName?: string } = {}) {
  return {
    eventId,
    products: [{ productCode: "00000001", name: overrides.productName ?? "通常商品", priceInclTax: 100, taxRate: 10, taxCategory: "inclusive_10", saleState: "on_sale", departmentId: "001" }],
    departments: [{ departmentId: "001", code: "001", name: overrides.departmentName ?? "通常部門", settlementOwnerId: "001", enabled: true }],
    quickEntries: [],
    staffMembers,
  };
}

async function sellOne(app: FastifyInstance, eventId: string) {
  const registerId = "register-1";
  const cashSessionId = await openRegisterForTest(app, eventId, "2026-08-02", registerId);
  const draft = (await app.inject({ method: "POST", url: `/api/v1/registers/${registerId}/sale-drafts`, payload: { eventId, businessDate: "2026-08-02", staffId: "001", terminalId: registerId } })).json();
  const line = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/lines`, headers: { "if-match": String(draft.version) }, payload: { productCode: "00000001" } });
  const paid = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/payments`, headers: { "if-match": String(line.json().version) }, payload: { kind: "cash", amountYen: 100, tenderedYen: 100 } });
  const sale = await app.inject({ method: "POST", url: `/api/v1/sale-drafts/${draft.draftId}/finalize`, headers: { "idempotency-key": `sale-${eventId}` }, payload: { version: paid.json().version } });
  return { cashSessionId, registerId, draft, line, paid, sale };
}

function decodeCp932(bytes: unknown): string {
  return new TextDecoder("shift_jis").decode(bytes as Buffer);
}

describe("印字できない文字を含むカタログの保存拒否（F-070/F-071・保存時検証）", () => {
  it("商品名に印字できない文字があるカタログは400で拒否され保存されない", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const response = await app.inject({ method: "PUT", url: "/api/v1/events/bad-product-event/catalog", payload: makeCatalog("bad-product-event", { productName: "商品🍎" }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("印字できない文字");
    expect(response.json().message).toContain("🍎");
    expect((await app.inject("/api/v1/events/bad-product-event/catalog")).statusCode).toBe(404);
  });

  it("部門名に印字できない文字があるカタログは400で拒否され保存されない", async () => {
    const app = buildApp({ database: openDatabase() }); apps.push(app);
    const response = await app.inject({ method: "PUT", url: "/api/v1/events/bad-dept-event/catalog", payload: makeCatalog("bad-dept-event", { departmentName: "部門🍎" }) });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("印字できない文字");
    expect((await app.inject("/api/v1/events/bad-dept-event/catalog")).statusCode).toBe(404);
  });
});

describe("保存済みの印字できない文字への印字時防御（F-070/F-071）", () => {
  it("部門名が既存データに残っていても中間点検・精算が成功し、集計は原文・印字は置換になる", async () => {
    const db: PosDatabase = openDatabase();
    const app = buildApp({ database: db }); apps.push(app);
    const eventId = "legacy-dept-event";
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: makeCatalog(eventId) })).statusCode).toBe(200);
    // 保存時検証が入る前に保存されたデータを再現する（catalog_json を直接書き換える）
    const record = db.prepare("SELECT catalog_json FROM event_catalogs WHERE event_id=?").get(eventId) as { catalog_json: string };
    db.prepare("UPDATE event_catalogs SET catalog_json=? WHERE event_id=?").run(record.catalog_json.replace("通常部門", "部門🍎"), eventId);

    const { cashSessionId, registerId, sale } = await sellOne(app, eventId);
    expect(sale.statusCode).toBe(201);
    const interim = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/interim`, payload: { counted: [{ denomination: 100, quantity: 1 }], terminalId: registerId } });
    expect(interim.statusCode, interim.body).toBe(201);
    const closing = await app.inject({ method: "POST", url: `/api/v1/cash-sessions/${cashSessionId}/checks/closing`, headers: { "idempotency-key": "legacy-dept-closing" }, payload: { counted: [{ denomination: 100, quantity: 1 }], carryoverYen: 100, terminalId: registerId } });
    expect(closing.statusCode, closing.body).toBe(201);
    expect((await app.inject(`/api/v1/cash-sessions/${cashSessionId}`)).json().state).toBe("closed");

    const job = db.prepare("SELECT payload_json, escpos_bytes FROM print_jobs WHERE document_type='cash-check' AND kind='closing'").get() as { payload_json: string; escpos_bytes: Buffer };
    // 集計（確定記録側）は原文を保持し、印字バイト列だけが置換される
    expect(JSON.parse(job.payload_json).settlementSummary.departments[0].name).toBe("部門🍎");
    const printed = decodeCp932(job.escpos_bytes);
    expect(printed).toContain("部門?");
    expect(printed).not.toContain("🍎");
  });

  it("商品名が既存データに残っていても確定が成功し、明細は原文・印字は置換になる", async () => {
    const db: PosDatabase = openDatabase();
    const app = buildApp({ database: db }); apps.push(app);
    const eventId = "legacy-product-event";
    expect((await app.inject({ method: "PUT", url: `/api/v1/events/${eventId}/catalog`, payload: makeCatalog(eventId) })).statusCode).toBe(200);
    // 保存時検証が入る前に保存されたデータを再現する（商品マスタを直接書き換える）
    db.prepare("UPDATE event_products SET name='商品🍎' WHERE event_id=? AND product_code='00000001'").run(eventId);

    const { line, paid, sale } = await sellOne(app, eventId);
    expect(line.statusCode).toBe(201);
    expect(paid.statusCode).toBe(201);
    expect(sale.statusCode, sale.body).toBe(201);
    const transactionId = sale.json().transactionId as string;
    const lineRow = db.prepare("SELECT product_name FROM transaction_lines WHERE transaction_id=?").get(transactionId) as { product_name: string };
    expect(lineRow.product_name).toBe("商品🍎");
    expect(db.prepare("SELECT COUNT(*) AS c FROM payments WHERE transaction_id=?").get(transactionId)).toEqual({ c: 1 });
    const job = db.prepare("SELECT escpos_bytes FROM print_jobs WHERE transaction_id=? AND document_type='receipt'").get(transactionId) as { escpos_bytes: Buffer };
    const printed = decodeCp932(job.escpos_bytes);
    expect(printed).toContain("商品?");
    expect(printed).not.toContain("🍎");
  });
});
