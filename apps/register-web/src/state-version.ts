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
