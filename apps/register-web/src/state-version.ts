import type { CheckoutDraft, CustomerProjection } from "./checkout-api.js";

export function shouldApplyDraft(current: CheckoutDraft | null, incoming: CheckoutDraft): boolean {
  if (!current) return true;
  if (current.draftId === incoming.draftId) return incoming.version >= current.version;
  return incoming.createdAt >= current.createdAt;
}

export function shouldApplyProjection(currentVersion: number, incoming: Pick<CustomerProjection, "version">): boolean {
  return incoming.version >= currentVersion;
}
