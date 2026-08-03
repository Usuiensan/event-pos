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
export type BackupArtifactDto = {
  artifactId: string; eventId: string; businessDate: string; cashboxId: string; cashSessionId: string; sourceCashCheckId: number;
  triggerKind: "interim" | "closing" | "manual_regeneration"; retryOfArtifactId?: string; state: "pending" | "generating" | "completed" | "failed";
  requestedBy?: string; requestedAt: string; startedAt?: string; completedAt?: string; outputDirectory?: string; backupPath?: string; workbookPath?: string; manifestPath?: string;
  backupSha256?: string; workbookSha256?: string; manifestSha256?: string; snapshotLogicalSha256?: string; rowCounts?: Record<string, number>; totals?: Record<string, number>;
  errorCode?: string; errorMessage?: string; attemptCount: number; canRegenerate: boolean;
};
export type CashSessionDto = {
  sessionId: string; eventId: string; businessDate: string; cashboxId: string; state: "preparing" | "open" | "closed"; openingYen: number | null; closingYen: number | null; theoreticalYen: number; createdAt: string;
  checks: Array<{ id: number; kind: "opening" | "interim" | "closing"; theoreticalYen: number; countedYen: number; differenceYen: number; carryoverYen: number; actorId?: string; terminalId?: string; createdAt: string }>;
  movements: Array<{ id: number; type: "sale" | "return" | "pay_in" | "pay_out"; amountYen: number; transactionId?: string; reason: string; actorId?: string; terminalId?: string; createdAt: string }>;
};
export type AuthActor = { authSessionId: string; staffId: string; eventId: string; responsibleNumber: string; displayName: string; role: "operator" | "manager" | "admin"; terminalId: string; csrfToken: string };
export type BusinessSessionDto = { businessSessionId: string; eventId: string; businessDate: string; sessionNo: number; state: "open" | "closed"; openedBy: string; openedTerminalId: string; openedAt: string; closedBy?: string; closedTerminalId?: string; closedAt?: string; reopenReason?: string };
export type RegisterStateDto = { business: BusinessSessionDto; cashSession: null | { session_id: string; cashbox_id: string; state: "preparing" | "open" | "closed"; opening_yen: number | null; closing_yen: number | null; created_at: string } };
export type HoldDto = { holdId: string; publicReference: string; publicReferenceDisplay: string; state: "active" | "claimed" | "released" | "carried"; lines: Array<{ productCode: string; name: string; quantity: number; shortage?: number }>; printJobId?: string };
export type CashCheckResult = { sessionId: string; kind: "opening" | "interim" | "closing"; theoreticalYen: number; countedYen: number; differenceYen: number; carryoverYen?: number; printJobId: string; backupArtifact?: BackupArtifactDto };
export type OperationsDashboardDto = { observedAt: string; database: { state: "ready" | "not_ready"; reason: string | null }; printerHost: { connected: boolean | null; observation: { observedAt: string } }; printJobs: { pending: number; failed: number; unknown: number; lastSuccessfulAt: string | null }; storage: { database: { state: "ok" | "unknown"; path: string | null; freeBytes: number | null; reason: string | null }; artifacts: { state: "ok" | "unknown"; path: string | null; freeBytes: number | null; reason: string | null } }; lastBackup: { completedAt: string; artifactId: string } | null; cash: { sessions: Array<{ cashboxId: string; state: string; openingYen: number | null; closingYen: number | null }>; checks: Array<{ cashboxId: string; kind: string; createdAt: string }> }; holds: { closingBlockers: Array<{ holdId: string; publicReferenceDisplay: string; state: string; businessSessionId: string | null; createdAt: string; printAttention: number; shortage: number }>; confirmationRequired: Array<{ holdId: string; publicReferenceDisplay: string; state: string; businessSessionId: string | null; createdAt: string; printAttention: number; shortage: number }> }; registers: Array<{ registerId: string; connected: boolean; terminalId: string | null; lastCommunicationAt: string | null; customerDisplay: { available: boolean; lastSeen?: string } }> };
export type ReturnableTransactionDto = { transactionId: string; publicReferenceDisplay: string; registerId: string; staffId: string; totalYen: number; paymentKind: string; createdAt: string; returnable: boolean; returnTransactionId?: string };
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

let csrfToken = "";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin", ...init, headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...(csrfToken && method !== "GET" && method !== "HEAD" ? { "x-csrf-token": csrfToken } : {}), ...init?.headers } });
  const body = await response.json().catch(() => null) as { error?: string | { code?: string; message?: string; details?: Record<string, unknown> }; message?: string } | T | null;
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? body.error : undefined;
    if (typeof error === "string") throw new CheckoutApiError(response.status, error, body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : "会計サーバーとの通信に失敗しました", {});
    throw new CheckoutApiError(response.status, error?.code ?? "CHECKOUT_API_ERROR", error?.message ?? "会計サーバーとの通信に失敗しました", error?.details ?? {});
  }
  return body as T;
}

const versionHeaders = (version: number): HeadersInit => ({ "if-match": String(version) });
const body = (value: unknown): string => JSON.stringify(value);

export const checkoutApi = {
  saveCatalog: (eventId: string, catalog: unknown) => request<void>(`/api/v1/events/${encodeURIComponent(eventId)}/catalog`, { method: "PUT", body: body(catalog) }),
  signIn: async (eventId: string, responsibleNumber: string, terminalId: string) => { const result = await request<{ actor: AuthActor }>("/api/v1/auth/sessions", { method: "POST", body: body({ eventId, responsibleNumber, terminalId }) }); csrfToken = result.actor.csrfToken; return result.actor; },
  getAuthSession: async () => { const result = await request<{ actor: AuthActor }>("/api/v1/auth/session"); csrfToken = result.actor.csrfToken; return result.actor; },
  signOut: async () => { await request<void>("/api/v1/auth/session", { method: "DELETE" }); csrfToken = ""; },
  getCurrentBusinessSession: (eventId: string) => request<{ session: BusinessSessionDto | null }>(`/api/v1/business-sessions/current?eventId=${encodeURIComponent(eventId)}`),
  openBusinessSession: (eventId: string, businessDate: string, terminalId: string) => request<BusinessSessionDto>("/api/v1/business-sessions", { method: "POST", body: body({ eventId, businessDate, terminalId }) }),
  closeBusinessSession: (businessSessionId: string, terminalId: string) => request<BusinessSessionDto>(`/api/v1/business-sessions/${encodeURIComponent(businessSessionId)}/close`, { method: "POST", body: body({ terminalId }) }),
  reopenBusinessSession: (businessSessionId: string, reason: string, terminalId: string) => request<BusinessSessionDto>(`/api/v1/business-sessions/${encodeURIComponent(businessSessionId)}/reopen`, { method: "POST", body: body({ reason, terminalId }) }),
  getRegisterState: (businessSessionId: string, registerId: string) => request<RegisterStateDto>(`/api/v1/business-sessions/${encodeURIComponent(businessSessionId)}/register-state?registerId=${encodeURIComponent(registerId)}`),
  prepareRegister: (businessSessionId: string, registerId: string, terminalId: string) => request<{ sessionId: string }>(`/api/v1/business-sessions/${encodeURIComponent(businessSessionId)}/registers/${encodeURIComponent(registerId)}/prepare`, { method: "POST", body: body({ terminalId }) }),
  createHold: (input: { eventId: string; registerId: string; terminalId: string; lines: Array<{ productCode: string; quantity: number }>; allowShortage?: boolean }) => request<HoldDto>("/api/v1/holds", { method: "POST", body: body(input) }),
  findHold: (eventId: string, reference: string) => request<HoldDto>(`/api/v1/holds/find?eventId=${encodeURIComponent(eventId)}&reference=${encodeURIComponent(reference)}`),
  claimHold: (holdId: string, draftId: string, version: number) => request<CheckoutDraft>(`/api/v1/holds/${encodeURIComponent(holdId)}/claim`, { method: "POST", body: body({ draftId, version }) }),
  releaseHold: (holdId: string, reason: string) => request<{ holdId: string; state: "released" }>(`/api/v1/holds/${encodeURIComponent(holdId)}/release`, { method: "POST", body: body({ reason }) }),
  reprintHold: (holdId: string, terminalId: string, reason: string) => request<{ holdId: string; printJobId: string }>(`/api/v1/holds/${encodeURIComponent(holdId)}/reprint`, { method: "POST", body: body({ terminalId, reason }) }),
  carryHold: (holdId: string, businessSessionId: string, terminalId: string) => request<{ holdId: string; state: "active" }>(`/api/v1/holds/${encodeURIComponent(holdId)}/carry`, { method: "POST", body: body({ businessSessionId, terminalId }) }),
  requestHoldCarryover: (holdId: string, terminalId: string) => request<{ holdId: string; state: "carried" }>(`/api/v1/holds/${encodeURIComponent(holdId)}/carry-request`, { method: "POST", body: body({ terminalId }) }),
  getCurrentCashSession: (eventId: string, businessDate: string, cashboxId: string, actorId: string) => request<{ session: CashSessionDto | null }>(`/api/v1/cash-sessions/current?eventId=${encodeURIComponent(eventId)}&businessDate=${encodeURIComponent(businessDate)}&cashboxId=${encodeURIComponent(cashboxId)}`, { headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId } }),
  createCashSession: (input: { sessionId: string; eventId: string; businessDate: string; cashboxId: string }, actorId: string) => request<CashSessionDto>("/api/v1/cash-sessions", { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId }, body: body(input) }),
  saveCashMovement: (sessionId: string, input: { type: "pay_in" | "pay_out"; amountYen: number; reason: string; idempotencyKey: string; terminalId: string }, actorId: string) => request<CashSessionDto>(`/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/movements`, { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId }, body: body(input) }),
  saveCashCheck: (sessionId: string, kind: "opening" | "interim" | "closing", input: { counted: Array<{ denomination: 1 | 5 | 10 | 50 | 100 | 500 | 1000 | 2000 | 5000 | 10000; quantity: number }>; carryoverYen?: number; terminalId: string }, actorId: string, idempotencyKey: string) => request<CashCheckResult>(`/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/checks/${kind}`, { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId, "idempotency-key": idempotencyKey }, body: body(input) }),
  reopenCashSession: (sessionId: string, reason: string, terminalId: string, actorId: string) => request<CashSessionDto>(`/api/v1/cash-sessions/${encodeURIComponent(sessionId)}/reopen`, { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId }, body: body({ reason, terminalId }) }),
  getOperationsDashboard: (eventId: string, businessDate: string, actorId: string) => request<OperationsDashboardDto>(`/api/v1/operations/dashboard?eventId=${encodeURIComponent(eventId)}&businessDate=${encodeURIComponent(businessDate)}`, { headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId } }),
  searchReturnableTransactions: (eventId: string, query: string, actorId: string) => request<{ transactions: ReturnableTransactionDto[] }>(`/api/v1/transactions/returnable?eventId=${encodeURIComponent(eventId)}&query=${encodeURIComponent(query)}`, { headers: { "x-pos-actor-id": actorId } }),
  createFullReturn: (transactionId: string, input: { cashSessionId: string; terminalId: string; reason: string }, actorId: string, idempotencyKey: string) => request<{ transactionId: string; originalTransactionId: string; publicReferenceDisplay: string; totalYen: number; printJobId: string; createdAt: string }>(`/api/v1/transactions/${encodeURIComponent(transactionId)}/full-return`, { method: "POST", headers: { "x-pos-actor-id": actorId, "idempotency-key": idempotencyKey }, body: body(input) }),
  createManualRefund: (input: { eventId: string; cashSessionId: string; terminalId: string; description: string; amountYen: number; productCode?: string; quantity?: number; paymentKind: "cash" | "credit" | "accounts_receivable" }, actorId: string, idempotencyKey: string) => request<{ transactionId: string; publicReferenceDisplay: string; totalYen: number; printJobId: string; createdAt: string }>("/api/v1/refunds/manual", { method: "POST", headers: { "x-pos-actor-id": actorId, "idempotency-key": idempotencyKey }, body: body(input) }),
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
  getBackupArtifacts: (eventId: string, businessDate: string, cashboxId: string, actorId: string) => request<{ artifacts: BackupArtifactDto[] }>(`/api/v1/backup-artifacts?eventId=${encodeURIComponent(eventId)}&businessDate=${encodeURIComponent(businessDate)}&cashboxId=${encodeURIComponent(cashboxId)}`, { headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId } }),
  regenerateBackupArtifact: (artifactId: string, actorId: string, idempotencyKey: string) => request<BackupArtifactDto>(`/api/v1/backup-artifacts/${encodeURIComponent(artifactId)}/regenerate`, { method: "POST", headers: { "x-pos-role": "manager", "x-pos-actor-id": actorId, "idempotency-key": idempotencyKey }, body: body({}) }),
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
