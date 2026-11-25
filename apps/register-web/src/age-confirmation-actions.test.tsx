import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { AgeConfirmationActions, type AgeFlowState } from "./age-confirmation-actions.js";

it("客側スキップはすぐ押せ、身分証を確認できたときだけ商品登録へ進む", () => {
  let state: AgeFlowState = "customer_pending";
  const onConfirm = vi.fn();
  const onReject = vi.fn();
  const actions = () => AgeConfirmationActions({ state, setState: (next) => { state = next; }, onConfirm, onReject });
  type ActionButton = ReactElement<{ children: string; onPointerUp: () => void }>;
  const buttons = () => Children.toArray(actions()?.props.children).filter(
    (child): child is ActionButton => isValidElement(child) && child.type === "button",
  );

  const pending = actions();
  expect(renderToStaticMarkup(pending)).not.toContain("disabled");
  expect(buttons().map(({ props }) => props.children)).toEqual(["客側スキップ"]);
  buttons()[0]?.props.onPointerUp();
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onReject).not.toHaveBeenCalled();
  expect(buttons().map(({ props }) => props.children)).toEqual(["確認できた", "確認できない"]);
  buttons()[0]?.props.onPointerUp();
  expect(onConfirm).toHaveBeenCalledOnce();
});
