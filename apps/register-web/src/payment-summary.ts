// 支払行の預り・釣銭の集計（F-075）。
// 複合支払では最初の支払行だけを見るとサーバー記録（payments の釣銭合計）と
// 完了画面が食い違うため、保存済み支払行の全行を合計して店員画面・顧客画面で使う。
// サーバー側の顧客射影（checkout-store.ts の publicProjection）と紙面
// （receiptSnapshot）も同じ全行集計で、表示数字は全経路で一致する。

export type PaymentAmountRow = {
  tenderedYen?: number;
  changeYen?: number;
};

export type PaymentSummary = {
  /** 預り金の合計（預りを持つ支払行のみ合計） */
  tenderedYen: number;
  /** 釣銭の合計（預りを持つ支払行のみ合計） */
  changeYen: number;
  /** 預りを持つ支払行が1つでもあるか（現金預りの有無の表示分岐に使う） */
  hasTendered: boolean;
};

export const EMPTY_PAYMENT_SUMMARY: PaymentSummary = { tenderedYen: 0, changeYen: 0, hasTendered: false };

export function summarizePayments(payments: ReadonlyArray<PaymentAmountRow>): PaymentSummary {
  let tenderedYen = 0;
  let changeYen = 0;
  let hasTendered = false;
  for (const payment of payments) {
    if (payment.tenderedYen === undefined) continue;
    hasTendered = true;
    tenderedYen += payment.tenderedYen;
    changeYen += payment.changeYen ?? 0;
  }
  return { tenderedYen, changeYen, hasTendered };
}

/** サーバー射影が集計済みの預り・釣銭（合計値）を PaymentSummary へ写す。 */
export function paymentSummaryFromTotals(tenderedYen: number | undefined, changeYen: number | undefined): PaymentSummary {
  if (tenderedYen === undefined) return EMPTY_PAYMENT_SUMMARY;
  return { tenderedYen, changeYen: changeYen ?? 0, hasTendered: true };
}
