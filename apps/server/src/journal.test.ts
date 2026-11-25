import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { openDatabase } from "./db.js";
import { openRegisterForTest } from "./test-support.js";

describe("ジャーナル参照", () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

  it("sessionNoを跨いで日付順に一覧化し、受付番号をハイフン有無で検索できる", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at) VALUES (?,?,?,?,?,?)").run("session-1", "event-j", "2026-10-31", "register-1", "open", "2026-10-31T08:00:00.000Z"); db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at) VALUES (?,?,?,?,?,?)").run("session-2", "event-j", "2026-10-31", "register-2", "open", "2026-10-31T08:00:00.000Z");
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("t-late", "session-2", "key-2", "event-j", "event-j:2026-10-31:2", "10000012", "1000-0012", "register-2", "staff-2", "sale", 1200, 1200, 0, 109, "cash", "2026-10-31T09:02:00.000Z");
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("t-early", "session-1", "key-1", "event-j", "event-j:2026-10-31:1", "10000011", "1000-0011", "register-1", "staff-1", "sale", 500, 500, 0, 45, "credit", "2026-10-31T09:01:00.000Z");
    const list = await app.inject({ method: "GET", url: "/api/v1/events/event-j/journal?date=2026-10-31" });
    expect(list.statusCode).toBe(200); expect(list.json().transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(["t-early", "t-late"]);
    expect((await app.inject({ method: "GET", url: "/api/v1/events/event-j/journal/lookup?reference=1000-0012" })).json()).toEqual({ transactionId: "t-late" });
    expect((await app.inject({ method: "GET", url: "/api/v1/events/event-j/journal/lookup?reference=10000011" })).json()).toEqual({ transactionId: "t-early" });
  });

  it("例外返金が営業日指定のジャーナル一覧に出る（新規分は営業日ID形式、修正前の日付のみ分も拾う）", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app);
    const installed = await app.inject({ method: "PUT", url: "/api/v1/events/event-j/catalog", payload: { eventId: "event-j", quickEntries: [], staffMembers: [{ responsibleNumber: "001", displayName: "試験管理者", role: "admin" }], products: [] } });
    expect(installed.statusCode).toBe(200);
    const sessionId = await openRegisterForTest(app, "event-j", "2026-11-25", "register-1");
    const refund = await app.inject({ method: "POST", url: "/api/v1/refunds/manual", headers: { "idempotency-key": "journal-manual-refund-1" }, payload: { eventId: "event-j", cashSessionId: sessionId, terminalId: "register-1", description: "レシートなし返金", amountYen: 350, paymentKind: "cash" } });
    expect(refund.statusCode).toBe(201);
    const id = refund.json().transactionId as string;
    expect(db.prepare("SELECT business_day_id FROM transactions WHERE transaction_id=?").get(id)).toEqual({ business_day_id: "event-j:2026-11-25:1" });
    // 修正前に日付のみの business_day_id で保存された例外返金も一覧に出ること
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("t-legacy-refund", sessionId, "key-legacy", "event-j", "2026-11-25", "R-10000020", "返金 1000-0020", "register-1", "staff-1", "return", -200, -200, 0, 0, "cash", "2026-11-25T09:05:00.000Z");
    const list = await app.inject({ method: "GET", url: "/api/v1/events/event-j/journal?date=2026-11-25" });
    expect(list.statusCode).toBe(200);
    expect(list.json().transactions.map((row: { transactionId: string }) => row.transactionId)).toEqual(expect.arrayContaining([id, "t-legacy-refund"]));
    const other = await app.inject({ method: "GET", url: "/api/v1/events/event-j/journal?date=2026-11-26" });
    expect(other.statusCode).toBe(200);
    expect(other.json().transactions.map((row: { transactionId: string }) => row.transactionId)).not.toContain(id);
    expect(other.json().transactions.map((row: { transactionId: string }) => row.transactionId)).not.toContain("t-legacy-refund");
  });

  it("詳細は明細、値引、支払、税、印刷job、領収書状態を返す", async () => {
    const db = openDatabase(); const app = buildApp({ database: db }); apps.push(app); const id = "t-detail";
    db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at) VALUES (?,?,?,?,?,?)").run("session-1", "event-j", "2026-10-31", "register-1", "open", "2026-10-31T08:00:00.000Z");
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,reason_text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,?)").run(id, "session-1", "key-detail", "event-j", "event-j:2026-10-31:1", "10000013", "1000-0013", "register-1", "staff-1", "sale", 900, 1000, 100, 82, "cash", null, "2026-10-31T09:03:00.000Z");
    db.prepare("INSERT INTO transaction_lines(transaction_line_id,transaction_id,line_no,source_draft_line_id,product_code,product_name,price_incl_tax,tax_rate_bps,tax_category,quantity,gross_yen,discount_yen,tax_yen,net_yen,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("line-1", id, 1, "draft-1", "P1", "商品A", 1000, 1000, "standard", 1, 1000, 100, 82, 900, "2026-10-31T09:03:00.000Z");
    db.prepare("INSERT INTO applied_discounts(applied_discount_id,transaction_id,source_key,label_snapshot,kind,value_kind,value,amount_yen,application_no,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("discount-1", id, "d1", "会員値引", "manual", "amount", 100, 100, 1, "2026-10-31T09:03:00.000Z");
    db.prepare("INSERT INTO payments(payment_id,transaction_id,sequence,kind,method_name_snapshot,amount_yen,created_at) VALUES (?,?,?,?,?,?,?)").run("payment-1", id, 1, "cash", "現金", 900, "2026-10-31T09:03:00.000Z");
    db.prepare("INSERT INTO tax_summaries(tax_summary_id,transaction_id,tax_rate_bps,taxable_gross_yen,discount_allocated_yen,taxable_net_yen,tax_amount_yen,rounding_mode) VALUES (?,?,?,?,?,?,?,?)").run("tax-1", id, 1000, 1000, 100, 900, 82, "floor");
    db.prepare("INSERT INTO print_jobs(job_id,transaction_id,printer_id,document_type,kind,payload_json,created_at,state,updated_at,source) VALUES (?,?,?,?,?,?,?,?,?,?)").run("job-1", id, "receipt-1", "receipt", "original", "{}", "2026-10-31T09:03:00.000Z", "completed", "2026-10-31T09:03:00.000Z", "test");
    const response = await app.inject({ method: "GET", url: `/api/v1/transactions/${id}/journal` });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ header: { publicReference: "1000-0013" }, lines: [{ name: "商品A", quantity: 1 }], discounts: [{ label: "会員値引", amountYen: 100 }], payments: [{ methodName: "現金", amountYen: 900 }], taxSummaries: [{ taxRateBps: 1000 }], printJobs: [{ jobId: "job-1", state: "completed" }], hasOfficialReceipt: false });
  });
});
