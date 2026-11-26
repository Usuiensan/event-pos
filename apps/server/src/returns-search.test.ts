import { describe, expect, it } from "vitest";
import { openDatabase } from "./db.js";
import { searchReturnableTransactions } from "./returns.js";

describe("返品検索の日付付きバーコード（F-072）", () => {
  const seed = () => {
    const db = openDatabase();
    db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at) VALUES (?,?,?,?,?,?)").run("s-new", "event-r", "2026-11-29", "register-1", "open", "2026-11-29T08:00:00.000Z");
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("t-new", "s-new", "k-new", "event-r", "event-r:2026-11-29:1", "0100000011", "01000-00011", "register-1", "staff-1", "sale", 500, 500, 0, 45, "cash", "2026-11-29T09:00:00.000Z");
    db.prepare("INSERT INTO cash_sessions(session_id,event_id,business_date,cashbox_id,state,created_at) VALUES (?,?,?,?,?,?)").run("s-old", "event-r", "2026-08-02", "register-1", "open", "2026-08-02T08:00:00.000Z");
    db.prepare("INSERT INTO transactions(transaction_id,session_id,idempotency_key,event_id,business_day_id,public_reference,public_reference_display,register_id,staff_id,type,total_yen,subtotal_yen,discount_total_yen,tax_total_yen,payment_kind,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("t-old", "s-old", "k-old", "event-r", "event-r:2026-08-02:1", "10000012", "1000-0012", "register-1", "staff-1", "sale", 500, 500, 0, 45, "cash", "2026-08-02T09:00:00.000Z");
    return db;
  };

  it("現行16桁バーコードで検索できる", () => {
    const db = seed();
    expect(searchReturnableTransactions(db, "event-r", "2611290100000011").map((row) => (row as unknown as { transactionId: string }).transactionId)).toEqual(["t-new"]);
  });
  it("旧14桁バーコードと受付番号単体でも従来どおり検索できる", () => {
    const db = seed();
    expect(searchReturnableTransactions(db, "event-r", "26080210000012").map((row) => (row as unknown as { transactionId: string }).transactionId)).toEqual(["t-old"]);
    expect(searchReturnableTransactions(db, "event-r", "0100000011").map((row) => (row as unknown as { transactionId: string }).transactionId)).toEqual(["t-new"]);
  });
  it("日付が違う16桁や検査数字が不正な16桁ではヒットしない", () => {
    const db = seed();
    expect(searchReturnableTransactions(db, "event-r", "2611280100000011")).toEqual([]);
    expect(searchReturnableTransactions(db, "event-r", "2611290100000012")).toEqual([]);
  });
});
