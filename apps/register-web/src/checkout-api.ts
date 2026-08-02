import type { ManualDiscountInput, SaleCalculation, TaxCategory } from "@event-pos/contracts";

export type CheckoutDraftLine = {
  lineId: string;
  lineNo: number;
  productId: string;
  productCode: string;
  name: string;
  priceInclTax: number;
  taxRate: number;
  taxCategory: TaxCategory;
  quantity: number;
  status: "active" | "canceled";
  source: "manual" | "scan" | "bundle" | "hold";
  manualDiscount?: ManualDiscountInput;
};
export type CheckoutDraftPayment = { paymentId: string; sequence: number; kind: PaymentKind; amountYen: number; tenderedYen?: number; changeYen?: number };
export type PaymentKind = "cash" | "credit" | "accounts_receivable" | "no_charge";
export type CheckoutDraft = {
  draftId: string;
  eventId: string;
  registerId: string;
  staffId: string;
  terminalId: string;
  businessDate: string;
  sessionNo: number;
  version: number;
  state: "editing" | "payment" | "finalizing" | "completed" | "canceled";
  completedTransactionId?: string;
  lines: CheckoutDraftLine[];
  payments: CheckoutDraftPayment[];
  ageVerifications: Array<{ verificationId: string; minimumAge: 18 | 20; method: "appearance" | "id_visual" | "self_declaration"; result: "passed" | "failed"; confirmerId?: string; terminalId: string; verifiedAt: string }>;
  calculation: SaleCalculation;
  createdAt: string;
  updatedAt: string;
};
export type FinalizeResult = { transactionId: string; draftId: string; draftVersion: number; publicReference: string; publicReferenceDisplay: string; totalYen: number; paymentKind: string; printJobId: string; printState: "queued"; completedAt: string };
export type CustomerProjection = {
  registerId: string;
  version: number;
  state: CheckoutDraft["state"];
  transactionId?: string;
  lines: Array<{ lineId: string; productCode: string; name: string; quantity: number; unitPriceYen: number; taxCategory: TaxCategory; netYen: number }>;
  discounts: Array<{ label: string; amountYen: number }>;
  totals: { subtotalYen: number; discountYen: number; taxYen: number; totalYen: number };
  payment: { state: "waiting" | "entered" | "completed"; kinds: PaymentKind[]; tenderedYen?: number; changeYen?: number };
};

export class CheckoutApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details: Record<string, unknown>) { super(message); }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers } });
  const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | T | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    throw new CheckoutApiError(response.status, error?.code ?? "CHECKOUT_API_ERROR", error?.message ?? "会計サーバーとの通信に失敗しました", error?.details ?? {});
  }
  return body as T;
}

const versionHeaders = (version: number): HeadersInit => ({ "if-match": String(version) });
const body = (value: unknown): string => JSON.stringify(value);

export const checkoutApi = {
  getRegisterDraft: (registerId: string) => request<CheckoutDraft>(`/api/v1/registers/${encodeURIComponent(registerId)}/sale-draft`),
  createDraft: (registerId: string, input: { eventId: string; staffId: string; terminalId: string; businessDate: string; sessionNo?: number }) => request<CheckoutDraft>(`/api/v1/registers/${encodeURIComponent(registerId)}/sale-drafts`, { method: "POST", body: body(input) }),
  getDraft: (draftId: string) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}`),
  addLine: (draftId: string, version: number, productCode: string, quantity = 1) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/lines`, { method: "POST", headers: versionHeaders(version), body: body({ productCode, quantity, source: "manual" }) }),
  addBundle: (draftId: string, version: number, bundleId: string) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/bundles`, { method: "POST", headers: versionHeaders(version), body: body({ bundleId }) }),
  updateLine: (draftId: string, lineId: string, version: number, input: { quantity?: number; manualDiscount?: ManualDiscountInput | null }) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/lines/${encodeURIComponent(lineId)}`, { method: "PATCH", headers: versionHeaders(version), body: body(input) }),
  cancelLine: (draftId: string, lineId: string, version: number) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/lines/${encodeURIComponent(lineId)}`, { method: "DELETE", headers: versionHeaders(version) }),
  addPayment: (draftId: string, version: number, input: { kind: PaymentKind; amountYen?: number; tenderedYen?: number }) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/payments`, { method: "POST", headers: versionHeaders(version), body: body(input) }),
  addAgeVerification: (draftId: string, version: number, input: { minimumAge: 18 | 20; method: "appearance" | "id_visual"; result: "passed"; confirmerId: string; terminalId: string }) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/age-verifications`, { method: "POST", headers: versionHeaders(version), body: body(input) }),
  cancelDraft: (draftId: string, version: number) => request<CheckoutDraft>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}`, { method: "DELETE", headers: versionHeaders(version) }),
  finalize: (draftId: string, version: number, idempotencyKey: string) => request<FinalizeResult>(`/api/v1/sale-drafts/${encodeURIComponent(draftId)}/finalize`, { method: "POST", headers: { "idempotency-key": idempotencyKey }, body: body({ version }) }),
  getCustomerProjection: (registerId: string) => request<CustomerProjection>(`/api/v1/customer-displays/${encodeURIComponent(registerId)}`),
};
