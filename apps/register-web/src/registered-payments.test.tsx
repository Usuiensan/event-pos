import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CheckoutDraftPayment } from "./checkout-api.js";
import { RegisteredPayments } from "./registered-payments.js";

const cashPayment: CheckoutDraftPayment = { paymentId: "pay-1", sequence: 1, kind: "cash", amountYen: 100, tenderedYen: 100, changeYen: 0 };
const creditPayment: CheckoutDraftPayment = { paymentId: "pay-2", sequence: 2, kind: "credit", amountYen: 300 };

function findButtons(node: ReactNode): Array<ReactElement<{ children?: ReactNode; onPointerUp?: () => void }>> {
  const found: Array<ReactElement<{ children?: ReactNode; onPointerUp?: () => void }>> = [];
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    const element = child as ReactElement<{ children?: ReactNode; onPointerUp?: () => void }>;
    if (element.type === "button") found.push(element);
    found.push(...findButtons(element.props.children));
  }
  return found;
}

describe("登録済み支払いの表示", () => {
  it("支払いが無ければ何も表示しない", () => {
    expect(RegisteredPayments({ payments: [], totalYen: 1000, onRemove: () => undefined })).toBeNull();
  });

  it("支払い内訳と残額を表示し、取消で対象の支払いを通知する", () => {
    const onRemove = vi.fn();
    const element = RegisteredPayments({ payments: [cashPayment, creditPayment], totalYen: 1000, onRemove });
    const markup = renderToStaticMarkup(element);
    expect(markup).toContain("登録済みの支払い 400円");
    expect(markup).toContain("残り 600円");
    expect(markup).toContain("現金");
    expect(markup).toContain("100円");
    expect(markup).toContain("お預り 100円");
    expect(markup).toContain("クレジット");
    expect(markup).toContain("300円");

    const buttons = findButtons(element?.props.children);
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.props.children)).toEqual(["取消", "取消"]);
    buttons[0]?.props.onPointerUp?.();
    expect(onRemove).toHaveBeenCalledOnce();
    expect(onRemove).toHaveBeenCalledWith(cashPayment);
    buttons[1]?.props.onPointerUp?.();
    expect(onRemove).toHaveBeenCalledWith(creditPayment);
  });
});
