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
export type FinalizeResult = { transactionId: string; draftId: string; draftVersion: number; publicReference: string; publicReferenceDisplay: string; totalYen: number; paymentKind: string; printJobId: string; printState: "pending"; completedAt: string };
export type PrintJobDto = { jobId: string; transactionId: string; state: "pending" | "sending" | "completed" | "failed" | "retry_wait" | "canceled"; deliveryCertainty?: "not_sent" | "accepted" | "unknown"; errorMessage?: string; reprintNo?: number };
export type TransactionDto = { transactionId: string; publicReferenceDisplay: string; printJob?: { jobId: string; state: string; createdAt: string } };
export type CustomerProjection = {
  registerId: string;
  draftId: string;
  version: number;
  draftVersion: number;
  state: CheckoutDraft["state"];
  transactionId?: string;
  lines: Array<{ lineId: string; productCode: string; name: string; quantity: number; unitPriceYen: number; taxCategory: TaxCategory; netYen: number }>;
  discounts: Array<{ label: string; amountYen: number }>;
  totals: { subtotalYen: number; discountYen: number; taxYen: number; totalYen: number };
  payment: { state: "waiting" | "entered" | "completed"; kinds: PaymentKind[]; tenderedYen?: number; changeYen?: number };
};
export type CustomerDisplayStatus = {
  registerId: string;
  available: boolean;
  terminalId?: string;
  lastSeen?: string;
  expiresAt?: string;
  heartbeatTtlMs: number;
  ageConfirmation: null | { requestId: string; registerId: string; draftId: string; minimumAge: 18 | 20; state: "requested" | "acknowledged" | "canceled"; requestedAt: string; respondedAt?: string };
};
export type AudioSettingsDto = { tapVolume: number; errorVolume: number; systemErrorVolume: number; speechVolume: number; speakerId: number; version: number; updatedAt: string };
export type AudioAnnouncement = { sequence: number; announcementId: string; text: string; createdAt: string };

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
  getTransaction: (transactionId: string) => request<TransactionDto>(`/api/v1/transactions/${encodeURIComponent(transactionId)}`),
  getPrintJob: (jobId: string) => request<PrintJobDto>(`/api/v1/print-jobs/${encodeURIComponent(jobId)}`),
  createReprint: (transactionId: string, actorId: string, input: { sourcePrintJobId: string; reason: string; physicalOutcome: "printed" | "not_printed" | "indeterminate"; riskAccepted: boolean; approval?: { approverId: string; approvedAt: string } }) => request<PrintJobDto>(`/api/v1/transactions/${encodeURIComponent(transactionId)}/reprints`, { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId }, body: body(input) }),
  openDrawer: (actorId: string) => request<PrintJobDto>("/api/v1/device-jobs/drawer", { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId } }),
  getCustomerProjection: (registerId: string, terminalId = registerId) => request<CustomerProjection>(`/api/v1/customer-displays/${encodeURIComponent(terminalId)}?registerId=${encodeURIComponent(registerId)}`),
  heartbeatCustomerDisplay: (terminalId: string, registerId: string) => request<void>(`/api/v1/customer-displays/${encodeURIComponent(terminalId)}/heartbeat`, { method: "POST", body: body({ registerId }) }),
  getCustomerDisplayStatus: (registerId: string) => request<CustomerDisplayStatus>(`/api/v1/registers/${encodeURIComponent(registerId)}/customer-display-status`),
  getAudioSettings: (registerId: string) => request<AudioSettingsDto>(`/api/v1/registers/${encodeURIComponent(registerId)}/audio-settings`),
  saveAudioSettings: (registerId: string, settings: Omit<AudioSettingsDto, "version" | "updatedAt">) => request<AudioSettingsDto>(`/api/v1/registers/${encodeURIComponent(registerId)}/audio-settings`, { method: "PUT", body: body(settings) }),
  announceSpeech: (registerId: string, text: string) => request<{ sequence: number; targetRole: "staff" | "customer"; targetTerminalId?: string }>(`/api/v1/registers/${encodeURIComponent(registerId)}/audio-announcements`, { method: "POST", body: body({ text }) }),
  getAudioAnnouncements: (terminalId: string, registerId: string, after = 0) => request<{ announcements: AudioAnnouncement[] }>(`/api/v1/customer-displays/${encodeURIComponent(terminalId)}/audio-announcements?registerId=${encodeURIComponent(registerId)}&after=${after}`),
  acknowledgeAudioAnnouncement: (terminalId: string, sequence: number) => request<void>(`/api/v1/customer-displays/${encodeURIComponent(terminalId)}/audio-announcements/${sequence}/ack`, { method: "POST" }),
  createAgeConfirmationRequest: (registerId: string, draftId: string, minimumAge: 18 | 20) => request<NonNullable<CustomerDisplayStatus["ageConfirmation"]>>(`/api/v1/registers/${encodeURIComponent(registerId)}/age-confirmation-requests`, { method: "POST", body: body({ draftId, minimumAge }) }),
  cancelAgeConfirmationRequest: (registerId: string, requestId: string) => request<void>(`/api/v1/registers/${encodeURIComponent(registerId)}/age-confirmation-requests/${encodeURIComponent(requestId)}`, { method: "DELETE" }),
  saveErrorReport: (errorId: string, content: string) => request<void>("/api/v1/error-reports", { method: "POST", body: body({ errorId, content }) }),
  acknowledgeAgeConfirmation: (terminalId: string, registerId: string, requestId: string) => request<NonNullable<CustomerDisplayStatus["ageConfirmation"]>>(`/api/v1/customer-displays/${encodeURIComponent(terminalId)}/age-confirmations`, { method: "POST", body: body({ registerId, requestId, response: "yes" }) }),
};
