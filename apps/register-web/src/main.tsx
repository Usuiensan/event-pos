import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateAutoDiscounts, exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, taxCategoryLabel, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, playOperationSound, speakAgeCheckRequired, speakChangeReady, speakEmergencyAlertReceived, speakIdentityMayBeRequested, speakProductPrice, speakReceiptReady, speakSubtotal, stopOperationSound, type SpeechPlayer } from "./speech.js";
import { demoCatalog } from "./demo-catalog.js";
import { normalizeResponsibleNumber } from "./responsible-number.js";
import { convertToTenThousands } from "./tender-input.js";
import { CheckoutApiError, checkoutApi, type CheckoutDraft, type CustomerProjection, type PaymentKind, type PrintJobDto } from "./checkout-api.js";
import { loadAudioSettings, normalizeAudioSettings, storeAudioSettings, type AudioSettings } from "./audio-settings.js";
import { connectRealtime } from "./realtime-client.js";
import { ageSkipRemainingSeconds, canSkipCustomerAgeConfirmation } from "./age-skip.js";
import { shouldApplyDraft, shouldApplyProjection } from "./state-version.js";
import { ErrorDialog, type PosError } from "./error-dialog.js";
import { formatPrintStatus } from "./print-status.js";
import "./styles.css";

const initialCatalog: EventCatalog = demoCatalog;

type RegisterRole = "staff" | "customer";
type EmergencyAlert = { id: string; title: string; message: string; receivedAt: string; source?: string };
type CartLine = { lineId?: string; product: ProductDefinition; quantity: number; cancelled?: boolean };

function App({ role, registerNumber }: { role: RegisterRole; registerNumber: number }) {
  const storageKey = (suffix: string) => `event-pos-register-${registerNumber}-${suffix}`;
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [serverDraft, setServerDraft] = useState<CheckoutDraft | null>(null);
  const [authoritativeTotal, setAuthoritativeTotal] = useState<number | null>(null);
  const [projectedDiscounts, setProjectedDiscounts] = useState<Array<{ label: string; amountYen: number }>>([]);
  const [responsibleNumber, setResponsibleNumber] = useState("");
  const [signedInResponsibleNumber, setSignedInResponsibleNumber] = useState("---");
  const [signedInUser, setSignedInUser] = useState("---");
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => {
    const loaded = loadAudioSettings(registerNumber);
    const legacySpeaker = Number(localStorage.getItem(storageKey("speaker")));
    return loaded.version === 0 && Number.isInteger(legacySpeaker) && legacySpeaker > 0 ? { ...loaded, speakerId: legacySpeaker } : loaded;
  });
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<{ name: string; quantity: number; unitPrice: number } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [productTab, setProductTab] = useState("all");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
  const [errorModal, setErrorModal] = useState<PosError | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [showPriceChange, setShowPriceChange] = useState(false);
  const [discountMode, setDiscountMode] = useState<"percent" | "amount" | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<"クレジット" | "売掛" | "無配" | null>(null);
  const [ageProduct, setAgeProduct] = useState<ProductDefinition | null>(null);
  const [ageFlowState, setAgeFlowState] = useState<"idle" | "staff_pending" | "customer_pending">("idle");
  const [ageVerified, setAgeVerified] = useState(false);
  const [ageVerifiedMinimum, setAgeVerifiedMinimum] = useState<0 | 18 | 20>(0);
  const [customerAgeNotice, setCustomerAgeNotice] = useState<"required" | "verified" | null>(null);
  const [customerAgeMinimum, setCustomerAgeMinimum] = useState<18 | 20>(20);
  const [customerAgeAcknowledged, setCustomerAgeAcknowledged] = useState(false);
  const [received, setReceived] = useState(0);
  const [inputBuffer, setInputBuffer] = useState("");
  const [paymentFinished, setPaymentFinished] = useState(false);
  const [completedPaymentLabel, setCompletedPaymentLabel] = useState("現金");
  const [emergencyAlert, setEmergencyAlert] = useState<EmergencyAlert | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [currentTransactionId, setCurrentTransactionId] = useState<string | null>(null);
  const [currentPublicReference, setCurrentPublicReference] = useState("");
  const [printJob, setPrintJob] = useState<PrintJobDto | null>(null);
  const [showReprint, setShowReprint] = useState(false);
  const [reprintOutcome, setReprintOutcome] = useState<"printed" | "not_printed" | "indeterminate">("not_printed");
  const [reprintReason, setReprintReason] = useState("");
  const [reprintRiskAccepted, setReprintRiskAccepted] = useState(false);
  const [reprintManagerApproved, setReprintManagerApproved] = useState(false);
  const [customerDisplayAvailable, setCustomerDisplayAvailable] = useState(false);
  const [ageConfirmationRequest, setAgeConfirmationRequest] = useState<{ requestId: string; minimumAge: 18 | 20; state: "requested" | "acknowledged" | "canceled"; requestedAt: string } | null>(null);
  const [ageCountdownSeconds, setAgeCountdownSeconds] = useState(0);
  const registerId = `register-${registerNumber}`;
  const [terminalId] = useState(() => {
    if (role === "staff") return registerId;
    const key = storageKey("customer-terminal-id");
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = `customer-${registerNumber}-${crypto.randomUUID()}`;
    localStorage.setItem(key, created);
    return created;
  });
  const ageRequirement = (product: ProductDefinition): 18 | 20 | null => product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : product.ageCheck === "none" ? null : /R18|18禁|成人向け/.test(product.name) ? 18 : /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name) ? 20 : null;
  const isAgeRestricted = (product: ProductDefinition) => ageRequirement(product) !== null;
  const showOperationError = (message: string) => { if (role === "staff") playOperationSound("error", audioSettings.errorVolume); setErrorModal({ kind: "operation", message }); };
  const showSystemError = (message: string) => { if (role === "staff") playOperationSound("system-error", audioSettings.errorVolume); setErrorModal({ kind: "system", message }); };
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId: audioSettings.speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const lastEmergencyAlertIdRef = useRef<string | null>(null);
  const draftRef = useRef<CheckoutDraft | null>(null);
  const draftMutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const paymentSubmittingRef = useRef(false);
  const projectionVersionRef = useRef(0);
  const audioSequenceRef = useRef(0);
  const audioRefreshRef = useRef<() => void>(() => undefined);
  const projectionRefreshRef = useRef<() => void>(() => undefined);
  const draftRefreshRef = useRef<() => void>(() => undefined);
  const triggerHighlight = (productCode: string) => {
    setHighlighted(productCode);
    if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>(".line-highlight").forEach((row) => {
        row.style.animation = "none";
        void row.offsetWidth;
        row.style.animation = "";
      });
    }));
    highlightTimeoutRef.current = window.setTimeout(() => { setHighlighted((current) => current === productCode ? null : current); highlightTimeoutRef.current = null; }, 750);
  };
  const productForLine = (line: { productCode: string; name: string; priceInclTax: number; taxRate: number; taxCategory: ProductDefinition["taxCategory"] }): ProductDefinition => catalog.products.find((product) => product.productCode === line.productCode) ?? { productCode: line.productCode, name: line.name, priceInclTax: line.priceInclTax, taxRate: line.taxRate, taxCategory: line.taxCategory, saleState: "on_sale" };
  const applyDraft = (draft: CheckoutDraft) => {
    const current = draftRef.current;
    if (!shouldApplyDraft(current, draft)) return;
    draftRef.current = draft; setServerDraft(draft); setAuthoritativeTotal(draft.calculation.totalYen); setProjectedDiscounts(draft.calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen })));
    setCart(draft.lines.map((line) => ({ lineId: line.lineId, product: productForLine(line), quantity: line.quantity, ...(line.status === "canceled" ? { cancelled: true } : {}) })));
    const cash = draft.payments.find((payment) => payment.kind === "cash");
    const payment = draft.payments[0];
    setReceived(cash?.tenderedYen ?? 0); setCompletedPaymentLabel(payment ? ({ cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" } as const)[payment.kind] : "現金");
    setPaymentFinished(draft.state === "completed");
    if (draft.state === "payment" && draft.payments.length === 0) setShowPayment(true);
    if (draft.state === "completed") { setShowPayment(false); setPendingPaymentMethod(null); setSelectedLine(null); setShowPriceChange(false); setCancelConfirm(false); }
    const verified = draft.ageVerifications.filter((item) => item.result === "passed" && (item.method === "appearance" || item.method === "id_visual")).reduce<0 | 18 | 20>((maximum, item) => Math.max(maximum, item.minimumAge) as 0 | 18 | 20, 0);
    setAgeVerified(verified > 0); setAgeVerifiedMinimum(verified);
  };
  const localBusinessDate = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const openDraft = async (staffId = signedInResponsibleNumber): Promise<CheckoutDraft> => {
    const current = draftRef.current;
    if (current && (current.state === "editing" || current.state === "payment" || current.state === "finalizing")) return current;
    if (!staffId || staffId === "---") throw new CheckoutApiError(401, "STAFF_SIGN_IN_REQUIRED", "責任者をサインオンしてください", {});
    try { const draft = await checkoutApi.createDraft(`register-${registerNumber}`, { eventId: catalog.eventId, staffId, terminalId: `register-${registerNumber}`, businessDate: localBusinessDate(), sessionNo: 1 }); applyDraft(draft); return draft; }
    catch (error) { if (!(error instanceof CheckoutApiError) || error.code !== "CATALOG_NOT_READY") throw error; await saveCatalog(catalog); const draft = await checkoutApi.createDraft(`register-${registerNumber}`, { eventId: catalog.eventId, staffId, terminalId: `register-${registerNumber}`, businessDate: localBusinessDate(), sessionNo: 1 }); applyDraft(draft); return draft; }
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "会計サーバーとの通信に失敗しました";
  const runDraftMutation = (operation: (draft: CheckoutDraft) => Promise<CheckoutDraft>): Promise<CheckoutDraft | null> => {
    if (draftRef.current?.state === "completed") { showOperationError("この取引は会計済みです。対象の操作はできません。"); return Promise.resolve(null); }
    const run = draftMutationQueueRef.current.then(async () => { const current = await openDraft(); const next = await operation(current); applyDraft(next); return next; });
    draftMutationQueueRef.current = run.catch(() => undefined);
    return run.catch((error) => { showSystemError(errorMessage(error)); return null; });
  };
  const activeCart = cart.filter((line) => !line.cancelled);
  const checkoutLocked = serverDraft?.state === "completed";
  const staffPermissions = new Set(catalog.staffMembers?.find((member) => member.responsibleNumber === signedInResponsibleNumber)?.permissions ?? []);
  const canCancelRegistration = activeCart.length > 0 && !checkoutLocked;
  const autoDiscounts = calculateAutoDiscounts(activeCart.reduce((quantities, line) => quantities.set(line.product.productCode, (quantities.get(line.product.productCode) ?? 0) + line.quantity), new Map<string, number>()), catalog.autoDiscountRules ?? []);
  const autoDiscountYen = autoDiscounts.reduce((sum, discount) => sum + discount.discountYen, 0);
  const customerRequiresAge = activeCart.some((line) => isAgeRestricted(line.product)) && customerAgeNotice !== "verified" && !customerAgeAcknowledged;
  const visibleProducts = catalog.products.filter((product) => productTab === "all" || product.tabId === productTab);
  const total = authoritativeTotal ?? activeCart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0) - autoDiscountYen;
  const ageCustomerSkipAvailable = ageFlowState === "customer_pending" && canSkipCustomerAgeConfirmation(customerDisplayAvailable, ageConfirmationRequest?.requestedAt ?? null);
  const routedSpeech = useMemo<SpeechPlayer>(() => ({
    get speakerId() { return speech.speakerId; },
    get volume() { return speech.volume; },
    setSpeaker(next) { speech.setSpeaker(next); },
    setVolume(next) { speech.setVolume(next); },
    speak(text) {
      void checkoutApi.announceSpeech(registerId, text).then((result) => { if (result.targetRole === "staff") speech.speak(text); }).catch(() => { if (!customerDisplayAvailable) speech.speak(text); });
    },
  }), [speech, registerId, customerDisplayAvailable]);
  const clearFinishedTransaction = () => { if (!checkoutLocked) return; setCart([]); draftRef.current = null; setServerDraft(null); setAuthoritativeTotal(0); setProjectedDiscounts([]); setLastAdded(null); setPaymentFinished(false); setCompletedPaymentLabel("現金"); setReceived(0); setInputBuffer(""); setAgeVerified(false); setAgeVerifiedMinimum(0); setAgeFlowState("idle"); setAgeConfirmationRequest(null); void openDraft().catch((error) => showSystemError(errorMessage(error))); };
  const submitReprint = () => {
    if (!currentTransactionId || !printJob) return showOperationError("再印刷元の取引と印刷jobを取得できません。");
    if (!reprintReason.trim()) return showOperationError("再印刷理由を入力してください。");
    const risky = reprintOutcome === "printed" || reprintOutcome === "indeterminate";
    if (risky && (!reprintRiskAccepted || !reprintManagerApproved)) return showOperationError("二重印刷リスク承認と責任者承認が必要です。");
    void checkoutApi.createReprint(currentTransactionId, signedInResponsibleNumber, { sourcePrintJobId: printJob.jobId, reason: reprintReason.trim(), physicalOutcome: reprintOutcome, riskAccepted: reprintRiskAccepted, ...(reprintManagerApproved ? { approval: { approverId: signedInResponsibleNumber, approvedAt: new Date().toISOString() } } : {}) })
      .then((job) => { setPrintJob(job); setShowReprint(false); setReprintReason(""); setReprintRiskAccepted(false); setReprintManagerApproved(false); })
      .catch((error) => showSystemError(errorMessage(error)));
  };
  const finishPayment = async (method: "現金" | "クレジット" | "売掛" | "無配", tenderedAmount?: number) => {
    if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。支払操作はできません。");
    if (!serverOnline) return showSystemError("会計サーバーへ接続できないため、オフライン中は会計を確定できません。");
    if (activeCart.length === 0) return showOperationError("商品が登録されていません。先に商品を登録してください。");
    const amount = method === "現金" ? tenderedAmount ?? Number(inputBuffer) : 0;
    if (method === "現金" && (tenderedAmount === undefined && !inputBuffer || !Number.isSafeInteger(amount) || amount < total)) return showOperationError("預り金が不足しています。合計金額以上を入力してください。");
    if (method === "現金" && amount - total >= 10000) return showOperationError("お釣りが10,000円以上になる預り金は入力できません。");
    if (paymentSubmittingRef.current) return;
    paymentSubmittingRef.current = true;
    try {
      let draft = await openDraft();
      const kind: PaymentKind = ({ "現金": "cash", "クレジット": "credit", "売掛": "accounts_receivable", "無配": "no_charge" } as const)[method];
      if (draft.payments.length === 0) { draft = await checkoutApi.addPayment(draft.draftId, draft.version, { kind, amountYen: kind === "no_charge" ? 0 : total, ...(kind === "cash" ? { tenderedYen: amount } : {}) }); applyDraft(draft); }
      const keyName = storageKey(`finalize-${draft.draftId}`); const idempotencyKey = localStorage.getItem(keyName) ?? crypto.randomUUID(); localStorage.setItem(keyName, idempotencyKey);
      await checkoutApi.finalize(draft.draftId, draft.version, idempotencyKey);
      const completed = await checkoutApi.getDraft(draft.draftId); applyDraft(completed);
      setReceived(amount); setCompletedPaymentLabel(method); setPaymentFinished(true); setShowPayment(false); setInputBuffer(""); playOperationSound("complete", audioSettings.tapVolume); localStorage.removeItem(keyName);
      if (method === "現金" && amount > total) speakChangeReady(routedSpeech); else speakReceiptReady(routedSpeech);
    } catch (error) { showSystemError(errorMessage(error)); }
    finally { paymentSubmittingRef.current = false; }
  };
  useEffect(() => { speech.setSpeaker(audioSettings.speakerId); speech.setVolume(audioSettings.speechVolume); storeAudioSettings(registerNumber, audioSettings); }, [audioSettings, registerNumber, speech]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { void checkoutApi.getAudioSettings(registerId).then((settings) => { if (!stopped) setAudioSettings((current) => { const next = normalizeAudioSettings(settings); if (next.version === 0 && current.version === 0 && (current.tapVolume !== 100 || current.errorVolume !== 100 || current.speechVolume !== 100 || current.speakerId !== 3)) { void checkoutApi.saveAudioSettings(registerId, current).then((saved) => setAudioSettings(normalizeAudioSettings(saved))); return current; } return next.version >= current.version ? next : current; }); }).catch(() => { /* 保存済み設定を維持する */ }); };
    refresh(); const timer = window.setInterval(refresh, 5_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [registerId]);
  useEffect(() => {
    if (role !== "customer") return;
    let stopped = false;
    const applyProjection = (projection: CustomerProjection) => {
      if (stopped || !shouldApplyProjection(projectionVersionRef.current, projection)) return;
      projectionVersionRef.current = projection.version;
      setCart(projection.lines.map((line) => ({ lineId: line.lineId, product: productForLine({ ...line, priceInclTax: line.unitPriceYen, taxRate: line.taxCategory.endsWith("_8") ? 8 : line.taxCategory.endsWith("_10") ? 10 : 0 }), quantity: line.quantity })));
      setAuthoritativeTotal(projection.totals.totalYen); setProjectedDiscounts(projection.discounts); setPaymentFinished(projection.payment.state === "completed"); setShowPayment(projection.payment.state === "entered"); setReceived(projection.payment.tenderedYen ?? 0);
      const kind = projection.payment.kinds[0]; if (kind) setCompletedPaymentLabel(({ cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" } as const)[kind]);
      if (projection.transactionId) void checkoutApi.getTransaction(projection.transactionId).catch(() => undefined);
    };
    const refresh = () => { void checkoutApi.getCustomerProjection(registerId, terminalId).then((projection) => { setServerOnline(true); applyProjection(projection); }).catch(() => setServerOnline(false)); };
    projectionRefreshRef.current = refresh; refresh(); const timer = window.setInterval(refresh, 1_000);
    return () => { stopped = true; window.clearInterval(timer); projectionRefreshRef.current = () => undefined; };
  }, [catalog.products, registerId, role, terminalId]);
  useEffect(() => {
    if (role !== "staff") return;
    let stopped = false;
    const refresh = () => { void checkoutApi.getRegisterDraft(registerId).then((draft) => { if (stopped) return; setServerOnline(true); applyDraft(draft); if (draft.completedTransactionId) void checkoutApi.getTransaction(draft.completedTransactionId).catch(() => undefined); }).catch((error) => { setServerOnline(false); if (error instanceof CheckoutApiError && error.status === 404) return; }); };
    draftRefreshRef.current = refresh; refresh(); const timer = window.setInterval(refresh, 1_000);
    return () => { stopped = true; window.clearInterval(timer); draftRefreshRef.current = () => undefined; };
  }, [catalog.products, registerId, role]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { void checkoutApi.getCustomerDisplayStatus(registerId).then((status) => {
      if (stopped) return;
      setServerOnline(true); setCustomerDisplayAvailable(status.available);
      const request = status.ageConfirmation && status.ageConfirmation.state !== "canceled" ? status.ageConfirmation : null;
      setAgeConfirmationRequest(request);
      if (request) { setCustomerAgeMinimum(request.minimumAge); setCustomerAgeNotice(request.state === "acknowledged" ? "verified" : "required"); }
      else if (role === "customer") setCustomerAgeNotice(null);
      if (role === "staff" && ageProduct && request?.state === "acknowledged") setAgeFlowState("staff_pending");
    }).catch(() => { if (!stopped) { setServerOnline(false); setCustomerDisplayAvailable(false); } }); };
    refresh(); const timer = window.setInterval(refresh, 1_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [ageProduct, registerId, role]);
  useEffect(() => {
    if (role !== "customer") return;
    const heartbeat = () => { void checkoutApi.heartbeatCustomerDisplay(terminalId, registerId).then(() => setServerOnline(true)).catch(() => setServerOnline(false)); };
    heartbeat(); const timer = window.setInterval(heartbeat, 2_000); return () => window.clearInterval(timer);
  }, [registerId, role, terminalId]);
  useEffect(() => {
    if (role !== "customer") return;
    let stopped = false;
    const refresh = () => { void checkoutApi.getAudioAnnouncements(terminalId, registerId, audioSequenceRef.current).then(async ({ announcements }) => {
      for (const announcement of announcements) { if (stopped || announcement.sequence <= audioSequenceRef.current) continue; audioSequenceRef.current = announcement.sequence; speech.speak(announcement.text); await checkoutApi.acknowledgeAudioAnnouncement(terminalId, announcement.sequence).catch(() => undefined); }
    }).catch(() => undefined); };
    audioRefreshRef.current = refresh; refresh(); const timer = window.setInterval(refresh, 1_000);
    return () => { stopped = true; window.clearInterval(timer); audioRefreshRef.current = () => undefined; };
  }, [registerId, role, speech, terminalId]);
  useEffect(() => connectRealtime({ registerId, terminalId, role, onReconnect: () => { draftRefreshRef.current(); projectionRefreshRef.current(); audioRefreshRef.current(); }, onNotification: (notification) => {
    const type = notification.type;
    if (type === "sale-draft.changed" || type === "transaction.finalized") draftRefreshRef.current();
    if (type === "customer-display.changed" || type === "age-confirmation.changed") projectionRefreshRef.current();
    if (type === "audio-announcement.changed") audioRefreshRef.current();
    if (type === "audio-settings.changed") void checkoutApi.getAudioSettings(registerId).then((settings) => setAudioSettings((current) => settings.version >= current.version ? normalizeAudioSettings(settings) : current));
  } }), [registerId, role, terminalId]);
  useEffect(() => { if (role !== "customer") return; const syncHighlight = (event: StorageEvent) => { if (event.key !== storageKey("line-highlight") || !event.newValue) return; try { const value = JSON.parse(event.newValue) as { highlightKey?: string; productCode?: string }; const highlightKey = value.highlightKey ?? (value.productCode ? `active:${value.productCode}` : null); if (!highlightKey) return; triggerHighlight(highlightKey); } catch { /* ignore malformed preview state */ } }; window.addEventListener("storage", syncHighlight); return () => window.removeEventListener("storage", syncHighlight); }, [role]);
  useEffect(() => () => { if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current); }, []);
  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector<HTMLElement>(".line-highlight");
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlighted, cart, panel]);
  useEffect(() => {
    if (!ageProduct || ageFlowState !== "customer_pending" || !ageConfirmationRequest) { setAgeCountdownSeconds(0); return; }
    const update = () => setAgeCountdownSeconds(ageSkipRemainingSeconds(ageConfirmationRequest.requestedAt));
    update(); const timer = window.setInterval(update, 250); return () => window.clearInterval(timer);
  }, [ageConfirmationRequest, ageFlowState, ageProduct]);
  useEffect(() => {
    if (role !== "staff") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (showSignIn || selectedLine !== null || isFormInput) return;
      if (checkoutLocked && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") { event.preventDefault(); return; }
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setInputBuffer((value) => value + event.key); return; }
      if (event.key === "Escape") { setInputBuffer(""); return; }
      if (event.key === "Enter" && inputBuffer) {
        event.preventDefault();
        if (total === 0) { const product = inputBuffer.length >= 8 ? catalog.products.find((candidate) => candidate.productCode === inputBuffer) : undefined; setInputBuffer(""); if (product) addProduct(product); else showOperationError(inputBuffer.length >= 8 ? "商品コードが見つかりません。登録済みコードを入力してください。" : "会計待ちです。商品を登録してから預り金を入力してください。"); return; }
        finishPayment("現金");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checkoutLocked, inputBuffer, role, selectedLine, showSignIn, total, catalog.products]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then(setCatalog).catch(() => { showSystemError("カタログを読み込めません。初期値を表示しています"); }); }, []);
  useEffect(() => {
    const transactionId = serverDraft?.completedTransactionId;
    if (!transactionId) { setCurrentTransactionId(null); setCurrentPublicReference(""); setPrintJob(null); return; }
    let stopped = false; let jobId = "";
    const refreshTransaction = () => void checkoutApi.getTransaction(transactionId).then((transaction) => { if (stopped) return; setCurrentTransactionId(transactionId); setCurrentPublicReference(transaction.publicReferenceDisplay ?? ""); jobId = transaction.printJob?.jobId ?? jobId; if (jobId) return checkoutApi.getPrintJob(jobId).then((job) => { if (!stopped) setPrintJob(job); }); }).catch(() => undefined);
    refreshTransaction(); const timer = window.setInterval(() => { if (jobId) void checkoutApi.getPrintJob(jobId).then((job) => { if (!stopped) setPrintJob(job); }).catch(() => undefined); else refreshTransaction(); }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [serverDraft?.completedTransactionId]);
  useEffect(() => { let stopped = false; const poll = () => { void fetch("/api/v1/emergency-alerts/latest", { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as { alert: EmergencyAlert | null } : null).then((result) => { const alert = result?.alert; if (stopped || !alert || alert.id === lastEmergencyAlertIdRef.current) return; lastEmergencyAlertIdRef.current = alert.id; setEmergencyAlert(alert); speakEmergencyAlertReceived(routedSpeech); }).catch(() => { /* 次回のポーリングで復旧する */ }); }; poll(); const timer = window.setInterval(poll, 1000); return () => { stopped = true; window.clearInterval(timer); }; }, [routedSpeech]);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const highlightLine = (productCode: string, state: "active" | "cancelled" = "active") => { const highlightKey = `${state}:${productCode}`; triggerHighlight(highlightKey); localStorage.setItem(storageKey("line-highlight"), JSON.stringify({ highlightKey, productCode, at: Date.now() })); };
  const addProduct = (product: ProductDefinition, quantity = 1, announce = true, ageCheckBypass = false) => {
    if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。商品登録はできません。");
    if (product.saleState !== "on_sale") return showOperationError("この商品は販売停止中のため登録できません。");
    const requiredAge = ageRequirement(product);
    if (!ageCheckBypass && requiredAge && (!ageVerified || ageVerifiedMinimum < requiredAge)) {
      setAgeProduct(product); setAgeFlowState("customer_pending"); setAgeConfirmationRequest(null);
      void openDraft().then((draft) => checkoutApi.createAgeConfirmationRequest(registerId, draft.draftId, requiredAge)).then((request) => { setAgeConfirmationRequest(request); speakAgeCheckRequired(routedSpeech); }).catch((error) => { setAgeProduct(null); setAgeFlowState("idle"); showSystemError(errorMessage(error)); });
      return;
    }
    void runDraftMutation((draft) => checkoutApi.addLine(draft.draftId, draft.version, product.productCode, quantity)).then((next) => { if (!next) return; setLastAdded({ name: product.name, quantity, unitPrice: product.priceInclTax }); playOperationSound("register", audioSettings.tapVolume); highlightLine(product.productCode); if (announce) speakProductPrice(routedSpeech, formatJapaneseYenSpeech(product.priceInclTax)); });
  };
  const addQuick = (quick: QuickEntry) => {
    if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。商品登録はできません。");
    const components = quick.productCode ? [{ productCode: quick.productCode, quantity: quick.quantity ?? 1 }] : (quick.components ?? []);
    const restricted = components.map((component) => catalog.products.find((item) => item.productCode === component.productCode)).find((product) => product && isAgeRestricted(product) && (!ageVerified || ageVerifiedMinimum < (ageRequirement(product) ?? 20)));
    if (restricted) { addProduct(restricted, components.find((component) => component.productCode === restricted.productCode)?.quantity ?? 1, false); return; }
    const addedTotal = components.reduce((sum, component) => sum + (catalog.products.find((product) => product.productCode === component.productCode)?.priceInclTax ?? 0) * component.quantity, 0);
    const operation = quick.components ? (draft: CheckoutDraft) => checkoutApi.addBundle(draft.draftId, draft.version, quick.id) : (draft: CheckoutDraft) => checkoutApi.addLine(draft.draftId, draft.version, quick.productCode!, quick.quantity ?? 1);
    void runDraftMutation(operation).then((next) => { if (next && addedTotal > 0) { playOperationSound("register", audioSettings.tapVolume); speakProductPrice(routedSpeech, formatJapaneseYenSpeech(addedTotal)); } });
  };
  const setQuantity = (lineIndex: number) => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。数量は変更できません。"); const line = cart[lineIndex]; if (!line?.lineId) return; const value = window.prompt("数量を入力", String(line.quantity)); const quantity = Number(value); if (Number.isSafeInteger(quantity) && quantity > 0) void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, line.lineId!, draft.version, { quantity })).then((next) => { if (next) highlightLine(line.product.productCode, line.cancelled ? "cancelled" : "active"); }); };
  const cancelRegistration = () => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。登録中止はできません。"); const draft = draftRef.current; if (!draft) return; void checkoutApi.cancelDraft(draft.draftId, draft.version).then((next) => { applyDraft(next); setLastAdded(null); setReceived(0); setPaymentFinished(false); setAgeVerified(false); setAgeProduct(null); setAgeFlowState("idle"); setAgeConfirmationRequest(null); if (ageConfirmationRequest) void checkoutApi.cancelAgeConfirmationRequest(registerId, ageConfirmationRequest.requestId); }).catch((error) => showSystemError(errorMessage(error))); };
  const selectedLineItem = selectedLine !== null ? cart[selectedLine] : undefined;
  const priceChangePreview = (() => { if (!selectedLineItem || !discountMode || !discountInput) return null; const value = Number(discountInput); if (!Number.isSafeInteger(value) || value < 0) return null; return discountMode === "percent" ? (value <= 100 ? Math.floor(selectedLineItem.product.priceInclTax * (100 - value) / 100) : null) : (value <= selectedLineItem.product.priceInclTax ? selectedLineItem.product.priceInclTax - value : null); })();
  const closePriceChange = () => { setShowPriceChange(false); setDiscountMode(null); setDiscountInput(""); };
  const applySelectedDiscount = () => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。売価・値引きは変更できません。"); if (!selectedLineItem?.lineId || selectedLine === null || priceChangePreview === null || !discountMode) return showOperationError(discountMode === "percent" ? "値引率は0～100％で入力してください。" : "値引額は現在の単価以下で入力してください。"); const value = Number(discountInput); void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, selectedLineItem.lineId!, draft.version, { manualDiscount: { kind: discountMode === "percent" ? "rate" : "amount", value } })).then((next) => { if (!next) return; highlightLine(selectedLineItem.product.productCode, selectedLineItem.cancelled ? "cancelled" : "active"); closePriceChange(); setSelectedLine(null); }); };
  useEffect(() => { if (!showPriceChange) return; const onDiscountKey = (event: KeyboardEvent) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setDiscountInput((current) => `${current}${event.key}`.replace(/^0+(?=\d)/, "").slice(0, 7)); } else if (event.key === "Backspace") { event.preventDefault(); setDiscountInput((current) => current.slice(0, -1)); } else if (event.key === "Escape") { event.preventDefault(); closePriceChange(); } else if (event.key === "Enter" && discountMode) { event.preventDefault(); applySelectedDiscount(); } }; window.addEventListener("keydown", onDiscountKey); return () => window.removeEventListener("keydown", onDiscountKey); }, [showPriceChange, discountMode, discountInput, priceChangePreview, selectedLine]);
  const confirmAge = () => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。年齢確認は変更できません。"); const product = ageProduct; const verifiedMinimum = product ? (ageRequirement(product) ?? 20) : 20; if (!product) return; void runDraftMutation(async (draft) => { const verified = await checkoutApi.addAgeVerification(draft.draftId, draft.version, { minimumAge: verifiedMinimum, method: "id_visual", result: "passed", confirmerId: signedInResponsibleNumber, terminalId: registerId }); return checkoutApi.addLine(verified.draftId, verified.version, product.productCode, 1); }).then((next) => { if (!next) return; if (ageConfirmationRequest) void checkoutApi.cancelAgeConfirmationRequest(registerId, ageConfirmationRequest.requestId); setAgeVerified(true); setAgeVerifiedMinimum(verifiedMinimum); setAgeFlowState("idle"); setAgeConfirmationRequest(null); setAgeProduct(null); setLastAdded({ name: product.name, quantity: 1, unitPrice: product.priceInclTax }); playOperationSound("register", audioSettings.tapVolume); speakProductPrice(routedSpeech, formatJapaneseYenSpeech(product.priceInclTax)); }); };
  const updateAudioSetting = (key: "tapVolume" | "errorVolume" | "speechVolume" | "speakerId", value: number) => {
    const requested = normalizeAudioSettings({ ...audioSettings, [key]: value });
    setAudioSettings(requested);
    void checkoutApi.saveAudioSettings(registerId, requested).then((savedValue) => {
      const saved = normalizeAudioSettings(savedValue);
      setAudioSettings((current) => {
        const valueHasChanged = current[key] !== requested[key];
        if (valueHasChanged) return { ...current, version: Math.max(current.version, saved.version) };
        return saved.version >= current.version ? saved : current;
      });
    }).catch((error) => showSystemError(errorMessage(error)));
  };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).catch((error) => showSystemError(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { showOperationError(error instanceof Error ? error.message : "JSONが不正です"); } };
  const customerCheckoutStatus = paymentFinished ? (completedPaymentLabel === "現金" ? `お預り ${received.toLocaleString()}円　お釣り ${Math.max(0, received - total).toLocaleString()}円` : `支払方法 ${completedPaymentLabel}　会計済み`) : showPayment ? (inputBuffer ? `お預り入力 ${Number(inputBuffer).toLocaleString()}円` : "お支払いをお願いします") : null;
  const displayDiscounts = role === "customer" ? projectedDiscounts : (serverDraft?.calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen })) ?? autoDiscounts.map((discount) => ({ label: `${discount.label}${discount.applications > 1 ? ` ×${discount.applications}` : ""}`, amountYen: discount.discountYen })));
  const isLineHighlighted = (line: { product: ProductDefinition; cancelled?: boolean }) => highlighted === `${line.cancelled ? "cancelled" : "active"}:${line.product.productCode}`;
  const emergencyModal = emergencyAlert && <div className="modal-backdrop emergency-layer"><section className="emergency-modal" role="alertdialog" aria-modal="true"><h2>緊急情報</h2><h3>{emergencyAlert.title}</h3><p>{emergencyAlert.message}</p><small>受信時刻 {new Date(emergencyAlert.receivedAt).toLocaleString("ja-JP")}</small><button onClick={() => setEmergencyAlert(null)}>確認</button></section></div>;
  if (role === "customer") return <main className="pos-screen customer-screen"><section className="customer-lines">{(customerAgeNotice || customerRequiresAge) && <div className={`age-notice ${customerAgeNotice === "verified" ? "" : "customer-age-prompt"} ${customerAgeNotice ?? "required"}`}><strong>{customerAgeNotice === "verified" ? `年齢確認済み（${customerAgeMinimum}歳以上）` : `あなたは${customerAgeMinimum}歳以上ですか？`}</strong>{customerAgeNotice !== "verified" && <button className="customer-age-yes" onPointerUp={() => { if (!ageConfirmationRequest || ageConfirmationRequest.state !== "requested") return; void checkoutApi.acknowledgeAgeConfirmation(terminalId, registerId, ageConfirmationRequest.requestId).then(() => { setCustomerAgeAcknowledged(true); setCustomerAgeNotice("verified"); speakIdentityMayBeRequested(speech); }).catch((error) => showSystemError(errorMessage(error))); }}>はい</button>}</div>}{cart.length === 0 ? <div className="customer-empty customer-welcome">{catalog.customerWelcome?.imageUrl && <img src={catalog.customerWelcome.imageUrl} alt="" />}{catalog.customerWelcome?.circleName && <strong>{catalog.customerWelcome.circleName}</strong>}{catalog.customerWelcome?.space && <span>{catalog.customerWelcome.space}</span>}<p>{catalog.customerWelcome?.message ?? "いらっしゃいませ"}</p></div> : <><div className="customer-line customer-line-head"><span>商品名</span><span>単価</span><span>点数</span></div>{cart.map((line, index) => <div data-product-code={line.product.productCode} className={`customer-line ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>@{line.product.priceInclTax.toLocaleString()}</span><span>{line.quantity}点</span></div>)}</>}{displayDiscounts.map((discount, index) => <div className="customer-discount" key={`${discount.label}-${index}`}><span>{discount.label}</span><strong>-{discount.amountYen.toLocaleString()}円</strong></div>)}</section><footer className="customer-total"><span>{customerCheckoutStatus ?? `合計 ${activeCart.reduce((sum, line) => sum + line.quantity, 0)}点`}</span><strong>{total.toLocaleString()}円</strong></footer>{emergencyModal}</main>;
  return <main className="pos-screen register-shell">
    <header className="register-header"><div className="header-actions"><button className="business-menu-button" onClick={() => setShowBusinessMenu(true)}>業務メニュー</button><button className="cancel-top" disabled={!canCancelRegistration} onClick={() => { if (canCancelRegistration) setCancelConfirm(true); }}>登録中止</button></div><p className="operation-guide">商品を登録してください。<br />登録が終わったら、小計を押して支払方法と預り金額を入力します。</p><p className="signed-in-user"><span>レジ{registerNumber}　{signedInUser}</span><span>責任者番号 {signedInResponsibleNumber}</span></p></header>
    {panel === "products" ? <section className="product-panel"><aside className="mini-cart"><button className="panel-switch" onClick={() => setPanel("detail")}>登録明細へ</button><div className="mini-cart-head"><span>商品名</span><span>数量</span><span>単価</span></div><div className="mini-cart-lines">{cart.length === 0 ? <div className="mini-cart-empty">登録待ち</div> : cart.map((line, index) => <div role="button" tabIndex={0} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`mini-cart-line ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span></div>)}</div><footer><span>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></aside><div className="product-picker"><div className="product-tabs"><button className={productTab === "all" ? "active" : ""} onClick={() => setProductTab("all")}>すべて</button>{(catalog.productTabs ?? []).map((tab) => <button key={tab.id} className={productTab === tab.id ? "active" : ""} style={tab.color ? { backgroundColor: tab.color } : undefined} onClick={() => setProductTab(tab.id)}>{tab.label}</button>)}</div><div className="product-grid">{visibleProducts.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} style={product.displayColor ? { backgroundColor: product.displayColor } : undefined} onClick={() => addProduct(product)}>{product.thumbnailUrl && <img className="product-thumbnail" src={product.thumbnailUrl} alt="" />}<strong>{product.name}</strong></button>)}{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><strong>{quick.label}</strong></button>)}</div></div></section> : <section className="detail-panel"><button className="panel-switch" onClick={() => setPanel("products")}>商品登録へ</button><div className="detail-head"><span>NO.</span><span>税区分</span><span>商品名</span><span>数量</span><span>単価</span><span>値引</span><span>操作</span></div>{cart.map((line, index) => <div role="button" tabIndex={0} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`detail-row ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>{taxCategoryLabel(line.product.taxCategory)}</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>{(serverDraft?.calculation.lines.find((item) => item.lineId === line.lineId)?.discountYen ?? 0).toLocaleString()}</span><span>タップして操作</span></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="staff-bottom"><div className="last-added">{displayDiscounts.map((discount, index) => <div className="auto-discount" key={`${discount.label}-${index}`}>{discount.label}　-{discount.amountYen.toLocaleString()}円</div>)}{lastAdded ? <><strong>{lastAdded.name}</strong><span>{lastAdded.quantity}個　{lastAdded.unitPrice.toLocaleString()}</span></> : <span>登録待ち</span>}{checkoutLocked && <div className={`print-status ${formatPrintStatus(printJob).className}`}><span>印刷</span><strong>{formatPrintStatus(printJob).label}</strong>{currentPublicReference && <small>受付 {currentPublicReference}</small>}</div>}</div><div className="checkout-summary"><div className="checkout-values"><div><span>合計</span><strong>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点　{total.toLocaleString()}円</strong></div><div><span>お預り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? completedPaymentLabel : `${received.toLocaleString()}円`}</strong></div><div><span>お釣り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? "—" : `${Math.max(0, received - total).toLocaleString()}円`}</strong></div></div>{checkoutLocked ? <button className="subtotal-large next-sale" onClick={clearFinishedTransaction}>次の取引</button> : <button className="subtotal-large" onClick={() => { if (activeCart.length === 0) return showOperationError("商品が登録されていません。先に商品を登録してください。"); setInputBuffer(""); setShowPayment(true); speakSubtotal(routedSpeech, `合計金額は ${formatJapaneseYenSpeech(total)}`); }}>小計</button>}</div></section>
    {inputBuffer && !showPayment && <div className="cash-popup"><span>お預り金額</span><strong>{Number(inputBuffer).toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showPayment && <div className="modal-backdrop payment-layer"><section className="payment-entry"><header><span>合計</span><strong>{total.toLocaleString()}円</strong></header><div className="payment-entry-body"><div className="payment-methods"><button onPointerUp={() => setPendingPaymentMethod("クレジット")}>クレジット</button><button onPointerUp={() => setPendingPaymentMethod("売掛")}>売掛</button><button onPointerUp={() => setPendingPaymentMethod("無配")}>無配</button><button className="payment-back" onPointerUp={() => { setShowPayment(false); setInputBuffer(""); }}>戻る</button></div><div className="payment-keypad"><div className="payment-amount"><span>お預り金額</span><strong>{inputBuffer ? Number(inputBuffer).toLocaleString() : "0"}円</strong></div><button className="exact-cash" onPointerUp={() => finishPayment("現金", total)}>ちょうど現計</button><button className="key-clear" onPointerUp={() => setInputBuffer("")}>C</button>{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onPointerUp={() => setInputBuffer((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 9))}>{key}</button>)}<button className="ten-thousand" onPointerUp={() => setInputBuffer(convertToTenThousands)}>万</button><button className="cash-complete" onPointerUp={() => finishPayment("現金")}>預・現計</button></div></div></section></div>}
    {pendingPaymentMethod && <div className="modal-backdrop error-layer"><div className="error-modal payment-confirm"><h2>支払方法の確認</h2><p>「{pendingPaymentMethod}」で会計を確定しますか？</p><button onPointerUp={() => { const method = pendingPaymentMethod; setPendingPaymentMethod(null); finishPayment(method); }}>確定</button><button onPointerUp={() => setPendingPaymentMethod(null)}>戻る</button></div></div>}
    {staffPermissions.has("catalog_import") && <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void file.text().then(importJson).catch(() => showSystemError("JSONファイルを読み込めませんでした。")); }} />}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><label>音声話者<select value={audioSettings.speakerId} onChange={(event) => updateAudioSetting("speakerId", Number(event.target.value))}><option value="3">ずんだもん</option><option value="2">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label><div className="audio-volume-settings">{([['tapVolume','タップ音'],['errorVolume','エラー音'],['speechVolume','音声読み上げ']] as const).map(([key,label]) => <label key={key}><span>{label}</span><input aria-label={`${label}の音量`} type="range" min="0" max="100" value={audioSettings[key]} onChange={(event) => updateAudioSetting(key, Number(event.target.value))} /><output>{audioSettings[key]}</output><button type="button" onClick={() => { if (key === 'tapVolume') playOperationSound('tap', audioSettings.tapVolume); else if (key === 'errorVolume') playOperationSound('error', audioSettings.errorVolume); else routedSpeech.speak('合計金額は ひゃく えん です'); }}>試聴</button></label>)}</div>{staffPermissions.has("catalog_import") && <button onClick={() => fileRef.current?.click()}>商品JSONインポート</button>}{staffPermissions.has("refund") && <button onClick={() => showOperationError("返金機能は準備中です。")}>返金</button>}{staffPermissions.has("reprint") && <button onClick={() => { if (!currentTransactionId || !printJob) return showOperationError("会計済み取引の印刷jobを取得してから再印刷してください。"); setShowBusinessMenu(false); setShowReprint(true); }}>再印刷</button>}<button onClick={() => { if (activeCart.length > 0) return showOperationError("登録中の商品があるため責任者を解除できません。登録を完了または中止してください。"); setShowBusinessMenu(false); setResponsibleNumber(""); setSignedInResponsibleNumber("---"); setSignedInUser("---"); setShowSignIn(true); }}>責任者解除</button><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {showReprint && <div className="modal-backdrop reprint-layer"><section className="reprint-modal"><h2>再印刷の確認</h2><p>元受付番号 <strong>{currentPublicReference}</strong></p><label>実物結果<select value={reprintOutcome} onChange={(event) => setReprintOutcome(event.target.value as typeof reprintOutcome)}><option value="not_printed">印字されていない</option><option value="printed">印字済み</option><option value="indeterminate">結果不明</option></select></label><label>理由<textarea value={reprintReason} onChange={(event) => setReprintReason(event.target.value)} placeholder="再印刷する理由を入力" /></label><label className="reprint-check"><input type="checkbox" checked={reprintRiskAccepted} onChange={(event) => setReprintRiskAccepted(event.target.checked)} />二重印刷リスクを承認する</label><label className="reprint-check"><input type="checkbox" checked={reprintManagerApproved} onChange={(event) => setReprintManagerApproved(event.target.checked)} />責任者 {signedInResponsibleNumber} として承認する（自己承認を監査）</label><p className="reprint-warning">印字済み・結果不明では、両方の承認が必須です。元jobは再送せず、新しい再印刷jobを作成します。</p><div><button onClick={submitReprint}>再印刷jobを作成</button><button onClick={() => setShowReprint(false)}>戻る</button></div></section></div>}
    {selectedLineItem && selectedLine !== null && !showPriceChange && <div className="modal-backdrop"><div className="line-menu"><h2>{selectedLineItem.product.name}</h2><button disabled={checkoutLocked} onClick={() => { if (checkoutLocked) return showOperationError("この取引は会計済みです。取消はできません。"); if (!selectedLineItem.lineId) return; void runDraftMutation((draft) => checkoutApi.cancelLine(draft.draftId, selectedLineItem.lineId!, draft.version)).then((next) => { if (!next) return; playOperationSound("cancel", audioSettings.tapVolume); highlightLine(selectedLineItem.product.productCode, "cancelled"); setSelectedLine(null); }); }}>取り消し</button><button disabled={checkoutLocked} onClick={() => { if (checkoutLocked) return showOperationError("この取引は会計済みです。数量は変更できません。"); setQuantity(selectedLine); setSelectedLine(null); }}>数量変更</button><button disabled={checkoutLocked} onClick={() => { if (checkoutLocked) return showOperationError("この取引は会計済みです。売価・値引きは変更できません。"); setShowPriceChange(true); }}>売価変更</button><button onClick={() => setSelectedLine(null)}>閉じる</button></div></div>}
    {selectedLineItem && selectedLine !== null && showPriceChange && <div className="modal-backdrop price-change-layer"><section className="price-change-modal"><header><span>{selectedLineItem.product.name}</span><strong>現在単価 {selectedLineItem.product.priceInclTax.toLocaleString()}円</strong></header>{discountMode === null ? <div className="discount-mode-selector"><p>値引き方法を選択してください</p><button onClick={() => { setDiscountMode("percent"); setDiscountInput(""); }}>％引き</button><button onClick={() => { setDiscountMode("amount"); setDiscountInput(""); }}>金額値引き</button><button className="price-change-back" onClick={closePriceChange}>戻る</button></div> : <div className="discount-entry"><div className="discount-display"><span>{discountMode === "percent" ? "値引率" : "値引額"}</span><strong>{discountInput ? Number(discountInput).toLocaleString() : "0"}{discountMode === "percent" ? "％" : "円"}</strong><small>変更後単価　{priceChangePreview === null ? "—" : `${priceChangePreview.toLocaleString()}円`}</small></div><div className="discount-keypad">{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onClick={() => setDiscountInput((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 7))}>{key}</button>)}<button className="discount-clear" onClick={() => setDiscountInput("")}>C</button><button className="discount-back" onClick={() => { setDiscountMode(null); setDiscountInput(""); }}>戻る</button><button className="discount-apply" disabled={priceChangePreview === null} onClick={applySelectedDiscount}>確定</button></div></div>}</section></div>}
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者番号を入力後、【サインオン】をタッチ</p><input aria-label="責任者番号" inputMode="numeric" maxLength={3} placeholder="責任者番号" value={responsibleNumber} onChange={(event) => setResponsibleNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /><button onPointerUp={() => { const normalized = normalizeResponsibleNumber(responsibleNumber); if (!normalized) return showOperationError("責任者番号を入力してください。"); const member = catalog.staffMembers?.find((candidate) => candidate.responsibleNumber === normalized); if (!member) return showOperationError("登録されていない責任者番号です。商品JSONのstaffMembersを確認してください。"); setResponsibleNumber(normalized); setSignedInResponsibleNumber(member.responsibleNumber); setSignedInUser(member.displayName); setShowSignIn(false); if (!draftRef.current) void openDraft(member.responsibleNumber).catch((error) => showSystemError(errorMessage(error))); }}>サインオン</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div>{ageFlowState === "staff_pending" && <><button onPointerUp={confirmAge}>確認できた</button><button onPointerUp={() => { if (ageConfirmationRequest) void checkoutApi.cancelAgeConfirmationRequest(registerId, ageConfirmationRequest.requestId); setAgeFlowState("idle"); setAgeConfirmationRequest(null); setAgeProduct(null); }}>確認できない</button></>}{ageFlowState === "customer_pending" && <><p className="age-skip-status">{ageCustomerSkipAvailable ? (customerDisplayAvailable ? "客側確認をスキップできます" : "顧客画面が未接続のため、すぐにスキップできます") : `客側スキップまで 残り${ageCountdownSeconds}秒`}</p><button className="customer-age-skip" disabled={!ageCustomerSkipAvailable} onPointerUp={() => { if (ageCustomerSkipAvailable) confirmAge(); }}>客側スキップ</button></>}</div></div>}
    {errorModal && <ErrorDialog error={errorModal} onConfirm={() => { stopOperationSound(); setErrorModal(null); }} onStop={stopOperationSound} />}
    {cancelConfirm && <div className="modal-backdrop error-layer"><div className="error-modal cancel-confirm"><h2>登録中止</h2><p>本当に登録を中止しますか？</p><button onClick={() => { cancelRegistration(); setCancelConfirm(false); }}>中止する</button><button onClick={() => setCancelConfirm(false)}>戻る</button></div></div>}
    {emergencyModal}
  </main>;
}

function Launcher() {
  const [registerNumber, setRegisterNumber] = useState(1);
  const openRegister = (role: RegisterRole) => { const url = new URL(window.location.href); url.search = new URLSearchParams({ register: String(registerNumber), role }).toString(); window.location.assign(url); };
  return <main className="launcher-screen"><section className="launcher-card"><div className="launcher-mark">POS</div><h1>event-pos</h1><p>使用するレジ番号と画面を選択してください。</p><fieldset><legend>レジ番号</legend><div className="register-selector">{[1, 2, 3, 4].map((number) => <button key={number} className={registerNumber === number ? "active" : ""} onClick={() => setRegisterNumber(number)}>レジ{number}</button>)}</div></fieldset><div className="role-selector"><button className="staff-launch" onClick={() => openRegister("staff")}><strong>店員側画面</strong><span>商品登録・会計操作</span></button><button className="customer-launch" onClick={() => openRegister("customer")}><strong>顧客側画面</strong><span>明細・合計・年齢確認</span></button></div><small>ホーム画面から起動した場合も、この画面で使用するレジを選択します。</small></section></main>;
}

function Root() {
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const registerNumber = Number(params.get("register"));
  useEffect(() => {
    if (role !== "staff" || !Number.isInteger(registerNumber)) return;
    const pointers = new Map<number, { control: HTMLElement; x: number; y: number }>();
    const rememberTapStart = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
      const control = event.target.closest<HTMLElement>('button, input:not([type="hidden"]), select, [role="button"]');
      if (!control || control.matches(":disabled, [aria-disabled=\"true\"]")) return;
      pointers.set(event.pointerId, { control, x: event.clientX, y: event.clientY });
    };
    const playTapFeedback = (event: PointerEvent) => {
      const start = pointers.get(event.pointerId);
      pointers.delete(event.pointerId);
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10 || !start.control.contains(event.target as Node)) return;
      playOperationSound("tap", loadAudioSettings(registerNumber).tapVolume);
    };
    const cancelTap = (event: PointerEvent) => pointers.delete(event.pointerId);
    document.addEventListener("pointerdown", rememberTapStart, { capture: true });
    document.addEventListener("pointerup", playTapFeedback, { capture: true });
    document.addEventListener("pointercancel", cancelTap, { capture: true });
    return () => { document.removeEventListener("pointerdown", rememberTapStart, { capture: true }); document.removeEventListener("pointerup", playTapFeedback, { capture: true }); document.removeEventListener("pointercancel", cancelTap, { capture: true }); };
  }, [registerNumber, role]);
  if ((role !== "staff" && role !== "customer") || !Number.isInteger(registerNumber) || registerNumber < 1 || registerNumber > 4) return <Launcher />;
  return <App role={role} registerNumber={registerNumber} />;
}

if (import.meta.env.PROD && "serviceWorker" in navigator) window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js"); });

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
