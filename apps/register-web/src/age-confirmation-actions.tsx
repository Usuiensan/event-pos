export type AgeFlowState = "idle" | "staff_pending" | "customer_pending";

export function AgeConfirmationActions({ state, setState, onConfirm, onReject }: {
  state: AgeFlowState;
  setState: (state: AgeFlowState) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  if (state === "staff_pending") return <>
    <button type="button" onPointerUp={onConfirm}>確認できた</button>
    <button type="button" onPointerUp={onReject}>確認できない</button>
  </>;
  if (state === "customer_pending") return <>
    <p className="age-skip-status">客側確認をスキップできます</p>
    <button type="button" className="customer-age-skip" onPointerUp={() => setState("staff_pending")}>客側スキップ</button>
  </>;
  return null;
}
