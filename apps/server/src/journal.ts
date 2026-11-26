import type { FastifyInstance } from "fastify";
import { parseDatedPublicReference } from "@event-pos/contracts";
import type { PosDatabase } from "./db.js";
import { CheckoutError, getTransactionSnapshot } from "./checkout-store.js";
import { AuthError, requireAuthActor } from "./auth.js";

type Options = { database: PosDatabase; authRequired: boolean };
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

function fail(reply: any, error: unknown) {
  if (error instanceof AuthError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: {} } });
  if (error instanceof CheckoutError) return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
  return reply.code(500).send({ error: { code: "JOURNAL_ERROR", message: "ジャーナルを取得できません", details: {} } });
}

export function registerJournalRoutes(app: FastifyInstance, options: Options): void {
  app.get<{ Params: { eventId: string }; Querystring: { date?: string; registerId?: string; type?: string } }>("/api/v1/events/:eventId/journal", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired);
      const date = request.query.date ?? new Date().toISOString().slice(0, 10);
      if (!datePattern.test(date)) throw new CheckoutError(400, "JOURNAL_DATE_INVALID", "dateはYYYY-MM-DD形式で指定してください");
      const prefix = `${request.params.eventId}:${date}:%`;
      const rows = options.database.prepare(`SELECT t.transaction_id AS transaction_id,t.public_reference_display AS public_reference_display,t.type,t.created_at,t.register_id,t.staff_id,t.total_yen,t.payment_kind,
        COUNT(tl.transaction_line_id) AS line_count,COALESCE(SUM(tl.quantity),0) AS item_count
        FROM transactions t LEFT JOIN transaction_lines tl ON tl.transaction_id=t.transaction_id
        WHERE t.event_id=? AND (t.business_day_id LIKE ? OR (t.business_day_id=? AND t.type='return')) AND (?='' OR t.register_id=?) AND (?='' OR t.type=?)
        GROUP BY t.transaction_id ORDER BY t.created_at ASC,t.transaction_id ASC`).all(request.params.eventId, prefix, date, request.query.registerId ?? "", request.query.registerId ?? "", request.query.type ?? "", request.query.type ?? "") as Array<Record<string, unknown>>;
      return { date, transactions: rows.map((row) => ({ transactionId: String(row.transaction_id), publicReference: String(row.public_reference_display ?? ""), type: String(row.type), createdAt: String(row.created_at), registerId: String(row.register_id ?? ""), staffId: String(row.staff_id ?? ""), lineCount: Number(row.line_count), itemCount: Number(row.item_count), totalYen: Number(row.total_yen), paymentKind: row.payment_kind })) };
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: { eventId: string }; Querystring: { reference?: string } }>("/api/v1/events/:eventId/journal/lookup", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired);
      const reference = (request.query.reference ?? "").trim().replace(/-/g, "");
      if (!reference) throw new CheckoutError(400, "REFERENCE_REQUIRED", "受付番号を入力してください");
      // 日付付きバーコード（旧14桁・現行16桁）は受付番号へ分解し、印字元の営業日も照合する。
      const dated = parseDatedPublicReference(reference);
      if (dated) {
        const datedRow = options.database.prepare("SELECT transaction_id FROM transactions WHERE event_id=? AND public_reference=? AND (business_day_id LIKE ? OR business_day_id=?) LIMIT 1").get(request.params.eventId, dated.publicReference, `${request.params.eventId}:${dated.businessDate}:%`, dated.businessDate) as { transaction_id: string } | undefined;
        if (!datedRow) throw new CheckoutError(404, "TRANSACTION_NOT_FOUND", "該当する取引が見つかりません");
        return { transactionId: datedRow.transaction_id };
      }
      const row = options.database.prepare("SELECT transaction_id FROM transactions WHERE event_id=? AND (public_reference=? OR REPLACE(public_reference_display,'-','')=? OR public_reference='R-' || ?) ORDER BY CASE WHEN public_reference=? THEN 0 ELSE 1 END LIMIT 1").get(request.params.eventId, reference, reference, reference, reference) as { transaction_id: string } | undefined;
      if (!row) throw new CheckoutError(404, "TRANSACTION_NOT_FOUND", "該当する取引が見つかりません");
      return { transactionId: row.transaction_id };
    } catch (error) { return fail(reply, error); }
  });

  app.get<{ Params: { transactionId: string } }>("/api/v1/transactions/:transactionId/journal", async (request, reply) => {
    try {
      requireAuthActor(options.database, request, "operator", options.authRequired);
      const transaction = options.database.prepare("SELECT type,public_reference,public_reference_display,created_at,register_id,staff_id,reason_text,original_transaction_id FROM transactions WHERE transaction_id=?").get(request.params.transactionId) as Record<string, unknown> | undefined;
      if (!transaction) throw new CheckoutError(404, "TRANSACTION_NOT_FOUND", "取引が見つかりません");
      const snapshot = getTransactionSnapshot(options.database, request.params.transactionId) as Record<string, unknown>;
      return { header: { type: transaction.type, publicReference: transaction.public_reference_display ?? transaction.public_reference, createdAt: transaction.created_at, registerId: transaction.register_id, staffId: transaction.staff_id, reasonText: transaction.reason_text, originalTransactionId: transaction.original_transaction_id }, lines: snapshot.lines, discounts: snapshot.discounts, payments: snapshot.payments, taxSummaries: snapshot.taxSummaries, printJobs: options.database.prepare("SELECT job_id AS jobId,document_type AS documentType,state,delivery_certainty AS deliveryCertainty,created_at AS createdAt,updated_at AS updatedAt,error_message AS errorMessage FROM print_jobs WHERE transaction_id=? ORDER BY created_at").all(request.params.transactionId), officialReceipts: options.database.prepare("SELECT receipt_id AS receiptId,created_at AS createdAt,print_job_id AS printJobId FROM official_receipts WHERE transaction_id=? ORDER BY created_at").all(request.params.transactionId), hasOfficialReceipt: !!options.database.prepare("SELECT 1 FROM official_receipts WHERE transaction_id=? LIMIT 1").get(request.params.transactionId) };
    } catch (error) { return fail(reply, error); }
  });
}
