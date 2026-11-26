import type { CheckoutDraft } from "./checkout-api.js";

// 明細0件でも支払行や取り置きの引当が残る下書きは、サーバー側では精算・閉局を
// 妨げる（ACTIVE_DRAFTS_EXIST）。画面からも登録中止・支払取消へ到達できるよう、
// 「解決すべき残りがあるか」を下書きの状態から判定する純粋関数群。
// 支払取消の可否ポリシーは新設せず、既存の支払取消経路への到達可否だけを扱う。

type DraftResolutionInput = Pick<CheckoutDraft, "state" | "lines" | "payments"> | null | undefined;

const isMutableDraft = (draft: NonNullable<DraftResolutionInput>): boolean =>
  draft.state === "editing" || draft.state === "payment";

export function draftHasActiveLines(draft: DraftResolutionInput): boolean {
  return !!draft && draft.lines.some((line) => line.status === "active");
}

export function draftHasPayments(draft: DraftResolutionInput): boolean {
  return !!draft && draft.payments.length > 0;
}

// 取り置きの引当は受取明細を取り消しても下書きを中止するまで残る。
// DTOには引当そのもののフィールドがないため、取消済みも含む hold 由来明細で判定する。
export function draftHasClaimedHoldLines(draft: DraftResolutionInput): boolean {
  return !!draft && draft.lines.some((line) => line.source === "hold");
}

export function draftHasResidualObligations(draft: DraftResolutionInput): boolean {
  return draftHasPayments(draft) || draftHasClaimedHoldLines(draft);
}

// 登録中止の対象: 有効明細がある下書きに加え、明細0件でも支払行・引当が残る下書き。
export function canCancelDraftRegistration(draft: DraftResolutionInput): boolean {
  if (!draft || !isMutableDraft(draft)) return false;
  return draftHasActiveLines(draft) || draftHasResidualObligations(draft);
}

// 小計（支払確認）へ進める条件: 有効明細がある場合に加え、支払行が残る場合は
// 明細0件でも支払の確認・取消に到達できるようにする。
export function canOpenDraftPayment(draft: DraftResolutionInput): boolean {
  if (!draft || !isMutableDraft(draft)) return false;
  return draftHasActiveLines(draft) || draftHasPayments(draft);
}
