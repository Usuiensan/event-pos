import type { BusinessSessionDto, CheckoutDraft, CustomerProjection } from "./checkout-api.js";

export function isActiveDraft(state: CheckoutDraft["state"]): boolean {
  return state === "editing" || state === "payment" || state === "finalizing";
}

export function draftMatchesBusiness(
  draft: Pick<CheckoutDraft, "eventId" | "businessDate" | "sessionNo">,
  business: Pick<BusinessSessionDto, "eventId" | "businessDate" | "sessionNo" | "state"> | null,
): boolean {
  return business?.state === "open" && draft.eventId === business.eventId
    && draft.businessDate === business.businessDate && draft.sessionNo === business.sessionNo;
}

export function shouldApplyDraft(current: CheckoutDraft | null, incoming: CheckoutDraft): boolean {
  if (!current) return true;
  if (current.draftId === incoming.draftId) return incoming.version >= current.version;
  const incomingActive = isActiveDraft(incoming.state);
  if (!incomingActive && (isActiveDraft(current.state) || current.state === "completed")) return false;
  if (incomingActive && (current.state === "canceled" || current.state === "completed")) return true;
  return incoming.createdAt >= current.createdAt;
}

export function shouldApplyProjection(currentVersion: number, incoming: Pick<CustomerProjection, "version">): boolean {
  return incoming.version >= currentVersion;
}

// 顧客表示の射影が属する営業の識別情報。sessionOrder は「営業日:営業番号
// （ゼロ埋め）」で、新しい営業ほど大きい。現金セッションIDだけでは新旧が分からない。
// exactOptionalPropertyTypes のため undefined の代入可を明示する。
export type ProjectionSession = { cashSessionId?: string | undefined; sessionOrder?: string | undefined };

export function projectionSessionSwitch(
  current: ProjectionSession | null,
  incoming: ProjectionSession,
): "same" | "newer" | "older" | "unknown" {
  if (!incoming.cashSessionId || !incoming.sessionOrder) return "unknown";
  if (!current?.cashSessionId || !current.sessionOrder) return "newer";
  if (incoming.cashSessionId === current.cashSessionId) return "same";
  return incoming.sessionOrder > current.sessionOrder ? "newer" : "older";
}
