import type { CheckoutDraftPayment, PaymentKind } from "./checkout-api.js";

const paymentKindLabels: Record<PaymentKind, string> = { cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" };

export function RegisteredPayments({ payments, totalYen, onRemove }: { payments: CheckoutDraftPayment[]; totalYen: number; onRemove: (payment: CheckoutDraftPayment) => void }) {
  if (payments.length === 0) return null;
  const paidYen = payments.reduce((sum, payment) => sum + payment.amountYen, 0);
  const remainingYen = Math.max(0, totalYen - paidYen);
  return <div className="registered-payments">
    <div className="registered-payments-summary"><span>登録済みの支払い {paidYen.toLocaleString()}円</span><strong>残り {remainingYen.toLocaleString()}円</strong></div>
    <ul>
      {payments.map((payment) => <li key={payment.paymentId}>
        <span className="registered-payment-kind">{paymentKindLabels[payment.kind]}</span>
        <span className="registered-payment-amount">{payment.amountYen.toLocaleString()}円{payment.kind === "cash" && payment.tenderedYen !== undefined ? `（お預り ${payment.tenderedYen.toLocaleString()}円）` : ""}</span>
        <button type="button" className="registered-payment-remove" onPointerUp={() => onRemove(payment)}>取消</button>
      </li>)}
    </ul>
  </div>;
}
