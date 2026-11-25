import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateAutoDiscounts, exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, parseBarcode, validatePublicReference, taxCategoryLabel, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, playOperationSound, previewSystemErrorSound, speakAgeCheckRequired, speakChangeReady, speakEmergencyAlertReceived, speakIdentityMayBeRequested, speakProductPrice, speakReceiptReady, speakSubtotal, stopOperationSound, type SpeechPlayer } from "./speech.js";
import { demoCatalog } from "./demo-catalog.js";
import { normalizeResponsibleNumber } from "./responsible-number.js";
import { convertToTenThousands } from "./tender-input.js";
import { CheckoutApiError, apiUrl, checkoutApi, type AuthActor, type BackupArtifactDto, type BusinessSessionDto, type CheckoutDraft, type CustomerProjection, type ParkedDraftDto, type PaymentKind, type PrintJobDto, type RegisterStateDto } from "./checkout-api.js";
import { loadAudioSettings, normalizeAudioSettings, storeAudioSettings, type AudioSettings } from "./audio-settings.js";
import { connectRealtime } from "./realtime-client.js";
import { AgeConfirmationActions, type AgeFlowState } from "./age-confirmation-actions.js";
import { isActiveDraft, shouldApplyDraft, shouldApplyProjection } from "./state-version.js";
import { ErrorDialog, type PosError } from "./error-dialog.js";
import { createErrorReportMailto, createSystemErrorReport, toPosSystemError } from "./error-report.js";
import { formatPrintStatus } from "./print-status.js";
import { formatBackupArtifactStatus } from "./backup-artifact-status.js";
import { CashOperations } from "./cash-operations.js";
import { OperationsDashboard } from "./operations-dashboard.js";
import { ReturnOperations } from "./return-operations.js";
import { Journal } from "./journal.js";
import { HoldOperations } from "./hold-operations.js";
import { StockAdjustment } from "./stock-adjustment.js";
import { DEFAULT_REASON, ReasonSelect } from "./reason-options.js";
import { AdminSettings } from "./admin-settings.js";
import { createUuid } from "./uuid.js";
import { loadStockDisplaySettings, normalizeStockDisplaySettings, stockIndicatorText, stockToneClass, storeStockDisplaySettings, type StockDisplaySettings } from "./stock-display-settings.js";
import { classifyScan, nextInputBuffer, scanRouteFor } from "./scan-routing.js";
import "./styles.css";

const initialCatalog: EventCatalog = demoCatalog;

// 表示専用のトレーニング判定（APIルーティングの判定には使わない）
const isTrainingMode = (): boolean => (globalThis as { __POS_TRAINING__?: boolean }).__POS_TRAINING__ === true || new URLSearchParams(window.location.search).get("mode") === "training" || window.location.port === "3002";
const TRAINING_BANNER = <div className="training-banner">トレーニングモード（本番ではありません）</div>;

type RegisterRole = "staff" | "customer";
type EmergencyAlert = { id: string; title: string; message: string; receivedAt: string; source?: string };
type CartLine = { lineId?: string; product: ProductDefinition; quantity: number; cancelled?: boolean };
type LineAnimationKind = "add" | "cancel" | "quantity" | "update";

const EMPTY_DETAIL_MESSAGE = "商品が登録されていません。商品登録から商品を選択してください。";

function RegisterHeader({
  businessSession,
  scanNotice,
  signedInUser,
  canOpenDrawer,
  onOpenBusinessMenu,
  onOpenDrawer,
  onSignOut,
  training,
}: {
  businessSession: BusinessSessionDto;
  scanNotice: string;
  signedInUser: string;
  canOpenDrawer: boolean;
  onOpenBusinessMenu: () => void;
  onOpenDrawer: () => void;
  onSignOut: () => void;
  training: boolean;
}) {
  return <header className="register-header">
    <div className="header-actions">
      {training && <span className="training-mode-badge">トレーニング</span>}
      <button className="business-menu-button" onClick={onOpenBusinessMenu}>業務メニュー</button>
    </div>
    <div className="operation-guide">
      <div>営業 {businessSession.sessionNo}／{businessSession.businessDate}／レジ営業中</div>
      <div className="operation-guide-description">商品登録後、小計ボタンを押してください。</div>
      {scanNotice && <div className="operation-guide-notice"><strong>{scanNotice}</strong></div>}
    </div>
    <div className="responsible-actions">
      <button type="button" className="drawer-button" disabled={!canOpenDrawer} onClick={onOpenDrawer}>ドロアーを開く</button>
      <button type="button" className="signed-in-user sign-out-button" onClick={onSignOut} aria-label="ログイン中の担当者を解除"><span>{signedInUser}</span></button>
    </div>
  </header>;
}

function DetailHeader() {
  return <div className="detail-head" role="row">
    <span>No.</span><span>税区分</span><span>商品名</span><span className="numeric-column">数量</span><span className="numeric-column">単価</span><span className="numeric-column">値引</span><span className="numeric-column">金額</span><span>操作</span>
  </div>;
}

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
  const [authActor, setAuthActor] = useState<AuthActor | null>(null);
  const [businessSession, setBusinessSession] = useState<BusinessSessionDto | null>(null);
  const [registerState, setRegisterState] = useState<RegisterStateDto["cashSession"]>(null);
  const [lifecycleLoading, setLifecycleLoading] = useState(false);
  const [lifecycleError, setLifecycleError] = useState("");
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => {
    const loaded = loadAudioSettings(registerNumber);
    const legacySpeaker = Number(localStorage.getItem(storageKey("speaker")));
    return loaded.version === 0 && Number.isInteger(legacySpeaker) && legacySpeaker > 0 ? { ...loaded, speakerId: legacySpeaker } : loaded;
  });
  const [stockDisplaySettings, setStockDisplaySettings] = useState<StockDisplaySettings>(() => loadStockDisplaySettings(registerNumber));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [highlightAnimation, setHighlightAnimation] = useState<LineAnimationKind>("update");
  const [recentAddedProducts, setRecentAddedProducts] = useState<Array<{ id: number; product: ProductDefinition; quantity: number }>>([]);
  const [lastAddedShortcut, setLastAddedShortcut] = useState<{ lineId: string; eligible: boolean } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [productTab, setProductTab] = useState("all");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
  const [showCashOperations, setShowCashOperations] = useState(false);
  const [showOperationsDashboard, setShowOperationsDashboard] = useState(false);
  const [showReturnOperations, setShowReturnOperations] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [journalReference, setJournalReference] = useState("");
  const [journalDate, setJournalDate] = useState<string | null>(null);
  const [returnReference, setReturnReference] = useState("");
  const [showHoldOperations, setShowHoldOperations] = useState(false);
  const [showStockAdjustment, setShowStockAdjustment] = useState(false);
  const [holdSearchReference, setHoldSearchReference] = useState("");
  const [showParkedDrafts, setShowParkedDrafts] = useState(false);
  const [parkedDrafts, setParkedDrafts] = useState<ParkedDraftDto[]>([]);
  const [parkedDraftsLoading, setParkedDraftsLoading] = useState(false);
  const [inventory, setInventory] = useState<Map<string, number | null>>(new Map());
  const [showOfficialReceipt, setShowOfficialReceipt] = useState(false);
  const [officialReceiptBusy, setOfficialReceiptBusy] = useState(false);
  const [errorModal, setErrorModal] = useState<PosError | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [quantityEditLine, setQuantityEditLine] = useState<CartLine | null>(null);
  const [quantityInput, setQuantityInput] = useState("");
  const [cancelFeedback, setCancelFeedback] = useState<{ product: ProductDefinition; quantity: number; amountYen: number } | null>(null);
  const cancelConfirmButtonRef = useRef<HTMLButtonElement>(null);
  const detailPanelRef = useRef<HTMLDivElement>(null);
  const [showPriceChange, setShowPriceChange] = useState(false);
  const [discountMode, setDiscountMode] = useState<"percent" | "amount" | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<"クレジット" | "売掛" | "無配" | null>(null);
  const [ageProduct, setAgeProduct] = useState<ProductDefinition | null>(null);
  const [ageFlowState, setAgeFlowState] = useState<AgeFlowState>("idle");
  const [ageVerified, setAgeVerified] = useState(false);
  const [ageVerifiedMinimum, setAgeVerifiedMinimum] = useState<0 | 18 | 20>(0);
  const [customerAgeNotice, setCustomerAgeNotice] = useState<"required" | "verified" | null>(null);
  const [customerAgeMinimum, setCustomerAgeMinimum] = useState<18 | 20>(20);
  const [customerAgeAcknowledged, setCustomerAgeAcknowledged] = useState(false);
  const [received, setReceived] = useState(0);
  const [inputBuffer, setInputBuffer] = useState("");
  const [scanNotice, setScanNotice] = useState("");
  const [pendingBook, setPendingBook] = useState<{ isbn?: string; priceCode?: string } | null>(null);
  const [pendingUnknownProduct, setPendingUnknownProduct] = useState<{ code: string; priceInput: string; taxRate: 0 | 8 | 10; saving: boolean } | null>(null);
  const [paymentFinished, setPaymentFinished] = useState(false);
  const [completedPaymentLabel, setCompletedPaymentLabel] = useState("現金");
  const [emergencyAlert, setEmergencyAlert] = useState<EmergencyAlert | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const [currentTransactionId, setCurrentTransactionId] = useState<string | null>(null);
  const [currentPublicReference, setCurrentPublicReference] = useState("");
  const [printJob, setPrintJob] = useState<PrintJobDto | null>(null);
  const [showReprint, setShowReprint] = useState(false);
  const [reprintOutcome, setReprintOutcome] = useState<"printed" | "not_printed" | "indeterminate">("not_printed");
  const [reprintReason, setReprintReason] = useState(DEFAULT_REASON);
  const [reprintRiskAccepted, setReprintRiskAccepted] = useState(false);
  const [reprintManagerApproved, setReprintManagerApproved] = useState(false);
  const [backupArtifacts, setBackupArtifacts] = useState<BackupArtifactDto[]>([]);
  const [backupArtifactsLoading, setBackupArtifactsLoading] = useState(false);
  const [backupArtifactsError, setBackupArtifactsError] = useState("");
  const [regeneratingArtifactId, setRegeneratingArtifactId] = useState<string | null>(null);
  const [customerDisplayAvailable, setCustomerDisplayAvailable] = useState(false);
  const [ageConfirmationRequest, setAgeConfirmationRequest] = useState<{ requestId: string; minimumAge: 18 | 20; state: "requested" | "acknowledged" | "canceled" } | null>(null);
  const staffAgeRequestRef = useRef<{ id: Promise<string | null>; confirming: boolean } | null>(null);
  const registerId = `register-${registerNumber}`;
  const [terminalId] = useState(() => {
    if (role === "staff") return registerId;
    const key = storageKey("customer-terminal-id");
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    const created = `customer-${registerNumber}-${createUuid()}`;
    localStorage.setItem(key, created);
    return created;
  });
  const ageRequirement = (product: ProductDefinition): 18 | 20 | null => product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : product.ageCheck === "none" ? null : /R18|18禁|成人向け/.test(product.name) ? 18 : /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name) ? 20 : null;
  const isAgeRestricted = (product: ProductDefinition) => ageRequirement(product) !== null;
  const showOperationError = (message: string) => { if (role === "staff") playOperationSound("error", audioSettings.errorVolume); setErrorModal({ kind: "operation", message }); };
  const showSystemError = (message: string, error?: unknown) => { if (role === "staff") playOperationSound("error", audioSettings.errorVolume); const report = createSystemErrorReport(message, error); setErrorModal(toPosSystemError(report, message)); void checkoutApi.saveErrorReport(report.errorId, report.content).catch(() => undefined); };
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId: audioSettings.speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const inputBufferRef = useRef("");
  const lastEmergencyAlertIdRef = useRef<string | null>(null);
  const draftRef = useRef<CheckoutDraft | null>(null);
  const draftMutationQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const paymentSubmittingRef = useRef(false);
  const projectionVersionRef = useRef(0);
  const audioSequenceRef = useRef(0);
  const audioRefreshRef = useRef<() => void>(() => undefined);
  const projectionRefreshRef = useRef<() => void>(() => undefined);
  const draftRefreshRef = useRef<() => void>(() => undefined);
  const lifecycleRefreshRef = useRef<() => void>(() => undefined);
  const inventoryRefreshRef = useRef<() => void>(() => undefined);
  const updateInputBuffer = (next: string | ((current: string) => string)) => { const value = typeof next === "function" ? next(inputBufferRef.current) : next; inputBufferRef.current = value; setInputBuffer(value); };
  const triggerHighlight = (highlightKey: string, animation: LineAnimationKind = highlightKey.startsWith("cancelled:") ? "cancel" : "update") => {
    setHighlighted(highlightKey);
    setHighlightAnimation(animation);
    if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      document.querySelectorAll<HTMLElement>(".line-highlight").forEach((row) => {
        row.style.animation = "none";
        void row.offsetWidth;
        row.style.animation = "";
      });
    }));
    highlightTimeoutRef.current = window.setTimeout(() => { setHighlighted((current) => current === highlightKey ? null : current); highlightTimeoutRef.current = null; }, 750);
  };
  const productForLine = (line: { productCode: string; name: string; priceInclTax: number; taxRate: number; taxCategory: ProductDefinition["taxCategory"] }): ProductDefinition => catalog.products.find((product) => product.productCode === line.productCode) ?? { productCode: line.productCode, name: line.name, priceInclTax: line.priceInclTax, taxRate: line.taxRate, taxCategory: line.taxCategory, saleState: "on_sale" };
  const applyDraft = (draft: CheckoutDraft, force = false) => {
    const current = draftRef.current;
    if (!force && !shouldApplyDraft(current, draft)) return;
    if (draft.state === "parked") {
      draftRef.current = draft; setServerDraft(draft); setCart([]); setAuthoritativeTotal(0); setProjectedDiscounts([]); setPaymentFinished(false); setReceived(0); setShowPayment(false); setSelectedLine(null); return;
    }
    const canceled = draft.state === "canceled";
    draftRef.current = draft; setServerDraft(draft); setAuthoritativeTotal(canceled ? 0 : draft.calculation.totalYen); setProjectedDiscounts(canceled ? [] : draft.calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen })));
    setCart(canceled ? [] : draft.lines.map((line) => ({ lineId: line.lineId, product: productForLine(line), quantity: line.quantity, ...(line.status === "canceled" ? { cancelled: true } : {}) })));
    const cash = draft.payments.find((payment) => payment.kind === "cash");
    const payment = draft.payments[0];
    setReceived(cash?.tenderedYen ?? 0); setCompletedPaymentLabel(payment ? ({ cash: "現金", credit: "クレジット", accounts_receivable: "売掛", no_charge: "無配" } as const)[payment.kind] : "現金");
    setPaymentFinished(draft.state === "completed");
    if (draft.state === "payment" && draft.payments.length === 0) setShowPayment(true);
    if (draft.state === "completed") { setShowPayment(false); setPendingPaymentMethod(null); setSelectedLine(null); setShowPriceChange(false); setCancelConfirm(false); }
    if (canceled) { setShowPayment(false); setPendingPaymentMethod(null); setSelectedLine(null); setShowPriceChange(false); setCancelConfirm(false); setRecentAddedProducts([]); setLastAddedShortcut(null); setReceived(0); updateInputBuffer(""); closeAgeConfirmation(); }
    const verified = draft.ageVerifications.filter((item) => item.result === "passed" && (item.method === "appearance" || item.method === "id_visual")).reduce<0 | 18 | 20>((maximum, item) => Math.max(maximum, item.minimumAge) as 0 | 18 | 20, 0);
    setAgeVerified(verified > 0); setAgeVerifiedMinimum(verified);
  };
  const localBusinessDate = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
  const refreshLifecycle = async () => {
    if (!authActor) return;
    const current = await checkoutApi.getCurrentBusinessSession(catalog.eventId);
    setBusinessSession(current.session);
    if (!current.session) { setRegisterState(null); return; }
    const snapshot = await checkoutApi.getRegisterState(current.session.businessSessionId, registerId);
    setRegisterState(snapshot.cashSession);
  };
  const openDraft = async (staffId = signedInResponsibleNumber): Promise<CheckoutDraft> => {
    const current = draftRef.current;
    if (current && isActiveDraft(current.state)) return current;
    if (!staffId || staffId === "---") throw new CheckoutApiError(401, "STAFF_SIGN_IN_REQUIRED", "責任者をサインオンしてください", {});
    if (!businessSession || registerState?.state !== "open") throw new CheckoutApiError(409, registerState ? "REGISTER_NOT_OPEN" : "BUSINESS_NOT_OPEN", "営業全体とレジを開局してから商品を登録してください", {});
    const draft = await checkoutApi.createDraft(`register-${registerNumber}`, { eventId: catalog.eventId, staffId, terminalId: `register-${registerNumber}`, businessDate: businessSession.businessDate, sessionNo: businessSession.sessionNo }); applyDraft(draft); return draft;
  };
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "会計サーバーとの通信に失敗しました";
  const runDraftMutation = (operation: (draft: CheckoutDraft) => Promise<CheckoutDraft>): Promise<CheckoutDraft | null> => {
    if (draftRef.current?.state === "completed") { showOperationError("この取引は会計済みです。対象の操作はできません。"); return Promise.resolve(null); }
    const run = draftMutationQueueRef.current.then(async () => { const current = await openDraft(); const next = await operation(current); applyDraft(next); return next; });
    draftMutationQueueRef.current = run.catch(() => undefined);
    return run.catch((error) => { showSystemError(errorMessage(error), error); return null; });
  };
  const activeCart = cart.filter((line) => !line.cancelled);
  const checkoutLocked = serverDraft?.state === "completed";
  const staffPermissions = new Set(catalog.staffMembers?.find((member) => member.responsibleNumber === signedInResponsibleNumber)?.permissions ?? []);
  staffPermissions.add("refund"); // 返品・返金行為そのものは権限で制限しない
  const canCancelRegistration = activeCart.length > 0 && !checkoutLocked;
  const autoDiscounts = calculateAutoDiscounts(activeCart.reduce((quantities, line) => quantities.set(line.product.productCode, (quantities.get(line.product.productCode) ?? 0) + line.quantity), new Map<string, number>()), catalog.autoDiscountRules ?? []);
  const autoDiscountYen = autoDiscounts.reduce((sum, discount) => sum + discount.discountYen, 0);
  const customerRequiresAge = activeCart.some((line) => isAgeRestricted(line.product)) && customerAgeNotice !== "verified" && !customerAgeAcknowledged;
  const visibleProducts = catalog.products.filter((product) => productTab === "all" || product.tabId === productTab);
  const total = authoritativeTotal ?? activeCart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0) - autoDiscountYen;
  const totalDiscountYen = role === "customer" ? projectedDiscounts.reduce((sum, discount) => sum + discount.amountYen, 0) : serverDraft?.calculation.discountTotalYen ?? autoDiscountYen;
  const routedSpeech = useMemo<SpeechPlayer>(() => ({
    get speakerId() { return speech.speakerId; },
    get volume() { return speech.volume; },
    setSpeaker(next) { speech.setSpeaker(next); },
    setVolume(next) { speech.setVolume(next); },
    speak(text) {
      void checkoutApi.announceSpeech(registerId, text).then((result) => { if (result.targetRole === "staff") speech.speak(text); }).catch(() => { if (!customerDisplayAvailable) speech.speak(text); });
    },
  }), [speech, registerId, customerDisplayAvailable]);
  const startNextTransaction = async (): Promise<boolean> => {
    if (!checkoutLocked && draftRef.current?.state !== "completed") return true;
    setCart([]); draftRef.current = null; setServerDraft(null); setAuthoritativeTotal(0); setProjectedDiscounts([]); setRecentAddedProducts([]); setLastAddedShortcut(null); setPaymentFinished(false); setCompletedPaymentLabel("現金"); setReceived(0); updateInputBuffer(""); setAgeVerified(false); setAgeVerifiedMinimum(0); setAgeFlowState("idle"); setAgeConfirmationRequest(null);
    try { await openDraft(); return true; } catch (error) { showSystemError(errorMessage(error), error); return false; }
  };
  const clearFinishedTransaction = () => { setCancelFeedback(null); void startNextTransaction(); };
  const submitReprint = () => {
    if (!currentTransactionId || !printJob) return showOperationError("再印刷元の取引と印刷jobを取得できません。");
    const risky = reprintOutcome === "printed" || reprintOutcome === "indeterminate";
    if (risky && (!reprintRiskAccepted || !reprintManagerApproved)) return showOperationError("二重印刷リスク承認と責任者承認が必要です。");
    void checkoutApi.createReprint(currentTransactionId, signedInResponsibleNumber, { sourcePrintJobId: printJob.jobId, reason: reprintReason.trim(), physicalOutcome: reprintOutcome, riskAccepted: reprintRiskAccepted, ...(reprintManagerApproved ? { approval: { approverId: signedInResponsibleNumber, approvedAt: new Date().toISOString() } } : {}) })
      .then((job) => { setPrintJob(job); setShowReprint(false); setReprintReason(DEFAULT_REASON); setReprintRiskAccepted(false); setReprintManagerApproved(false); })
      .catch((error) => showSystemError(errorMessage(error), error));
  };
  const refreshInventory = () => {
    if (role !== "staff") return;
    void checkoutApi.getInventory(catalog.eventId).then(({ products }) => setInventory(new Map(products.map((product) => [product.productCode, product.tracked ? product.available : null])))).catch(() => undefined);
  };
  const refreshParkedDrafts = () => {
    setParkedDraftsLoading(true);
    void checkoutApi.getParkedDrafts(registerId, catalog.eventId).then(setParkedDrafts).catch((error) => showSystemError(errorMessage(error), error)).finally(() => setParkedDraftsLoading(false));
  };
  const clearParkedCart = () => { setCart([]); draftRef.current = null; setServerDraft(null); setAuthoritativeTotal(0); setProjectedDiscounts([]); setPaymentFinished(false); setCompletedPaymentLabel("現金"); setReceived(0); updateInputBuffer(""); setSelectedLine(null); setRecentAddedProducts([]); setLastAddedShortcut(null); setAgeVerified(false); setAgeVerifiedMinimum(0); };
  const parkCurrentDraft = (onSuccess?: () => void) => {
    const draft = draftRef.current;
    if (!draft || activeCart.length === 0) return showOperationError("保留する明細がありません。");
    if (draft.state !== "editing") return showOperationError("支払前の登録明細だけ保留できます。");
    void checkoutApi.parkDraft(draft.draftId, terminalId).then((result) => { clearParkedCart(); setScanNotice(`保留しました（受付番号 ${result.parkReferenceDisplay}）`); refreshParkedDrafts(); onSuccess?.(); }).catch((error) => showSystemError(errorMessage(error), error));
  };
  const resumeParkedDraft = (parkReference: string) => {
    void checkoutApi.resumeParkedDraft(registerId, parkReference, terminalId).then((draft) => { applyDraft(draft, true); setShowParkedDrafts(false); setScanNotice(`保留中の受付番号 ${parkReference} を呼び戻しました`); }).catch((error) => { if (error instanceof CheckoutApiError && error.status === 409) showOperationError("現在の会計に明細があるため、呼び戻せません。"); else showSystemError(errorMessage(error), error); });
  };
  const issueOfficialReceipt = () => {
    if (!currentTransactionId) return showOperationError("会計済み取引を取得できません。");
    setOfficialReceiptBusy(true);
    void checkoutApi.createOfficialReceipt(currentTransactionId, { terminalId, payeeName: "", memo: "" }).then(() => { setShowOfficialReceipt(false); setScanNotice("領収書を発行しました。"); }).catch((error) => showSystemError(errorMessage(error), error)).finally(() => setOfficialReceiptBusy(false));
  };
  const openJournalReprint = (transactionId: string, reference: string, job: PrintJobDto | null) => { setCurrentTransactionId(transactionId); setCurrentPublicReference(reference); setPrintJob(job); setShowJournal(false); if (!job) return showOperationError("元取引の印刷jobが見つかりません。"); setShowReprint(true); };
  const openJournalReceipt = (transactionId: string) => { setCurrentTransactionId(transactionId); setShowJournal(false); setShowOfficialReceipt(true); };
  const openJournalReturn = (reference: string) => { setReturnReference(reference); setShowJournal(false); setShowReturnOperations(true); };
  const regenerateBackupArtifact = (artifact: BackupArtifactDto) => {
    if (!artifact.canRegenerate || regeneratingArtifactId) return;
    const keyName = storageKey(`backup-regenerate-${artifact.artifactId}`); const idempotencyKey = localStorage.getItem(keyName) ?? createUuid(); localStorage.setItem(keyName, idempotencyKey);
    setRegeneratingArtifactId(artifact.artifactId);
    void checkoutApi.regenerateBackupArtifact(artifact.artifactId, signedInResponsibleNumber, idempotencyKey)
      .then((created) => { localStorage.removeItem(keyName); setBackupArtifacts((current) => [created, ...current.filter((item) => item.artifactId !== created.artifactId)]); setBackupArtifactsError(""); })
      .catch((error) => showSystemError(errorMessage(error), error))
      .finally(() => setRegeneratingArtifactId(null));
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
      const keyName = storageKey(`finalize-${draft.draftId}`); const idempotencyKey = localStorage.getItem(keyName) ?? createUuid(); localStorage.setItem(keyName, idempotencyKey);
      await checkoutApi.finalize(draft.draftId, draft.version, idempotencyKey);
      inventoryRefreshRef.current();
      const completed = await checkoutApi.getDraft(draft.draftId);
      if (draftRef.current?.draftId === completed.draftId) { applyDraft(completed); updateInputBuffer(""); }
      playOperationSound("complete", audioSettings.tapVolume); localStorage.removeItem(keyName);
      if (method === "現金" && amount > total) speakChangeReady(routedSpeech); else speakReceiptReady(routedSpeech);
    } catch (error) { showSystemError(errorMessage(error), error); }
    finally { paymentSubmittingRef.current = false; }
  };
  useEffect(() => { speech.setSpeaker(audioSettings.speakerId); speech.setVolume(audioSettings.speechVolume); storeAudioSettings(registerNumber, audioSettings); }, [audioSettings, registerNumber, speech]);
  useEffect(() => {
    if (role !== "staff") return;
    let stopped = false;
    void checkoutApi.getAuthSession().then((actor) => { if (!stopped) { setAuthActor(actor); setSignedInResponsibleNumber(actor.responsibleNumber); setSignedInUser(actor.displayName); setShowSignIn(false); } }).catch(() => undefined);
    return () => { stopped = true; };
  }, [role]);
  useEffect(() => {
    if (role !== "staff" || !authActor) return;
    let stopped = false;
    const refresh = () => { setLifecycleLoading(true); void refreshLifecycle().then(() => { if (!stopped) { setLifecycleError(""); setServerOnline(true); } }).catch((error) => { if (stopped) return; setLifecycleError(errorMessage(error)); setServerOnline(false); if (error instanceof CheckoutApiError && error.status === 401) { setAuthActor(null); setBusinessSession(null); setRegisterState(null); setShowSignIn(true); } }).finally(() => { if (!stopped) setLifecycleLoading(false); }); };
    lifecycleRefreshRef.current = refresh;
    refresh(); const timer = window.setInterval(refresh, 2_000);
    return () => { stopped = true; lifecycleRefreshRef.current = () => undefined; window.clearInterval(timer); };
  }, [authActor, catalog.eventId, registerId, role]);
  useEffect(() => {
    if (!showBusinessMenu || role !== "staff" || signedInResponsibleNumber === "---") return;
    let stopped = false;
    const refresh = () => {
      if (!backupArtifacts.length) setBackupArtifactsLoading(true);
      void checkoutApi.getBackupArtifacts(catalog.eventId, localBusinessDate(), registerId, signedInResponsibleNumber)
        .then(({ artifacts }) => { if (!stopped) { setBackupArtifacts(artifacts); setBackupArtifactsError(""); } })
        .catch((error) => { if (!stopped) setBackupArtifactsError(errorMessage(error)); })
        .finally(() => { if (!stopped) setBackupArtifactsLoading(false); });
    };
    refresh(); const timer = window.setInterval(refresh, 2_000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [showBusinessMenu, role, catalog.eventId, registerId, signedInResponsibleNumber]);
  useEffect(() => { if (!showBusinessMenu || role !== "staff") return; const menu = document.querySelector<HTMLElement>(".business-menu"); if (!menu || menu.querySelector(".business-menu-top-link")) return; const link = document.createElement("a"); link.className = "business-menu-top-link"; link.href = "/"; link.textContent = "トップページへ"; menu.appendChild(link); return () => link.remove(); }, [showBusinessMenu, role]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { void checkoutApi.getAudioSettings(registerId).then((settings) => { if (!stopped) setAudioSettings((current) => { const next = normalizeAudioSettings(settings); if (next.version === 0 && current.version === 0 && (current.tapVolume !== 100 || current.errorVolume !== 100 || current.systemErrorVolume !== 100 || current.speechVolume !== 100 || current.speakerId !== 3)) { void checkoutApi.saveAudioSettings(registerId, current).then((saved) => setAudioSettings(normalizeAudioSettings(saved))); return current; } return next.version >= current.version ? next : current; }); }).catch(() => { /* 保存済み設定を維持する */ }); };
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
    if (role !== "staff" || !authActor) return;
    let stopped = false;
    const refresh = () => {
      const draftId = draftRef.current?.draftId;
      void checkoutApi.getRegisterDraft(registerId).then(async (draft) => {
        const current = draftRef.current;
        if (stopped || current?.draftId !== draftId) return;
        setServerOnline(true);
        // レジの取得結果が別の非アクティブな下書きなら、操作中の下書き自身の状態を確認する。
        if (current && current.draftId !== draft.draftId && isActiveDraft(current.state) && !isActiveDraft(draft.state)) {
          draft = await checkoutApi.getDraft(current.draftId);
          if (stopped || draftRef.current?.draftId !== draftId) return;
        }
        applyDraft(draft);
      }).catch((error) => { if (stopped || error instanceof CheckoutApiError && error.status === 404) return; setServerOnline(false); });
    };
    draftRefreshRef.current = refresh; refresh(); const timer = window.setInterval(refresh, 1_000);
    return () => { stopped = true; window.clearInterval(timer); draftRefreshRef.current = () => undefined; };
  }, [authActor, catalog.products, registerId, role]);
  useEffect(() => {
    let stopped = false;
    const refresh = () => { void checkoutApi.getCustomerDisplayStatus(registerId).then((status) => {
      if (stopped) return;
      setServerOnline(true); setCustomerDisplayAvailable(status.available);
      const request = status.ageConfirmation && status.ageConfirmation.state !== "canceled" ? status.ageConfirmation : null;
      setAgeConfirmationRequest(request);
      if (request) { setCustomerAgeMinimum(request.minimumAge); setCustomerAgeNotice(request.state === "acknowledged" ? "verified" : "required"); }
      else if (role === "customer") setCustomerAgeNotice(null);
      if (role === "staff" && ageProduct && request?.state === "acknowledged") {
        const pendingRequest = staffAgeRequestRef.current;
        void pendingRequest?.id.then((requestId) => {
          if (!stopped && staffAgeRequestRef.current === pendingRequest && request.requestId === requestId) setAgeFlowState("staff_pending");
        });
      }
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
    if (type === "business-state.changed" || type === "register-state.changed") lifecycleRefreshRef.current();
    if (type === "audio-settings.changed") void checkoutApi.getAudioSettings(registerId).then((settings) => setAudioSettings((current) => settings.version >= current.version ? normalizeAudioSettings(settings) : current));
  } }), [registerId, role, terminalId]);
  useEffect(() => { if (role !== "customer") return; const syncHighlight = (event: StorageEvent) => { if (event.key !== storageKey("line-highlight") || !event.newValue) return; try { const value = JSON.parse(event.newValue) as { highlightKey?: string; productCode?: string; animation?: LineAnimationKind }; const highlightKey = value.highlightKey ?? (value.productCode ? `active:${value.productCode}` : null); if (!highlightKey) return; triggerHighlight(highlightKey, value.animation); } catch { /* ignore malformed preview state */ } }; window.addEventListener("storage", syncHighlight); return () => window.removeEventListener("storage", syncHighlight); }, [role]);
  useEffect(() => () => { if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current); }, []);
  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector<HTMLElement>(".line-highlight");
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlighted, cart, panel]);
  useEffect(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(".line-highlight"));
    const animationClasses = ["line-animation-add", "line-animation-cancel", "line-animation-quantity", "line-animation-update"];
    rows.forEach((row) => { row.classList.remove(...animationClasses); row.classList.add(`line-animation-${highlightAnimation}`); });
    return () => rows.forEach((row) => row.classList.remove(...animationClasses));
  }, [highlighted, highlightAnimation, cart, panel]);
  useEffect(() => {
    if (cancelConfirm) cancelConfirmButtonRef.current?.focus();
  }, [cancelConfirm]);
  useEffect(() => {
    if (!quantityEditLine) return;
    const onQuantityKey = (event: KeyboardEvent) => {
      if (/^[0-9]$/.test(event.key)) {
        event.preventDefault();
        setQuantityInput((current) => `${current}${event.key}`.replace(/^0+(?=\d)/, ""));
      } else if (event.key === "Backspace") {
        event.preventDefault();
        setQuantityInput((current) => current.slice(0, -1));
      } else if (event.key === "Escape") {
        event.preventDefault();
        setQuantityEditLine(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        const quantity = Number(quantityInput);
        if (!quantityEditLine.lineId || !Number.isSafeInteger(quantity) || quantity <= 0) return;
        const line = quantityEditLine;
        setQuantityEditLine(null);
        if (lastAddedShortcut?.lineId === line.lineId) setLastAddedShortcut({ lineId: line.lineId!, eligible: false });
        void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, line.lineId!, draft.version, { quantity })).then((next) => {
          if (next) highlightLine(line.product.productCode, line.cancelled ? "cancelled" : "active", line.cancelled ? "cancel" : "quantity");
        });
      }
    };
    window.addEventListener("keydown", onQuantityKey);
    return () => window.removeEventListener("keydown", onQuantityKey);
  }, [quantityEditLine, quantityInput, lastAddedShortcut]);
  useEffect(() => {
    if (selectedLine !== null) setCancelFeedback(null);
  }, [selectedLine]);
  useEffect(() => {
    if (role !== "staff") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (showSignIn || selectedLine !== null || isFormInput) return;
       if (event.key === "*" || event.key === "Multiply") { event.preventDefault(); if (inputBufferRef.current === "4") applyLastAddedQuantityShortcut(); updateInputBuffer(""); return; }
       if (/^[0-9]$/.test(event.key) || /^[\x21-\x7E]$/.test(event.key)) { const next = nextInputBuffer(inputBufferRef.current, event.key); if (next !== inputBufferRef.current) { event.preventDefault(); updateInputBuffer(next); } return; }
       if (event.key === "Escape") { updateInputBuffer(""); return; }
       if (event.key === "Enter" && inputBufferRef.current) {
         event.preventDefault();
         const scanned = inputBufferRef.current; updateInputBuffer("");
         const route = scanRouteFor(scanned, { checkoutLocked, total });
         if (route === "barcode") { handleBarcode(scanned); return; }
         if (route === "discard") return;
        finishPayment("現金");
        return;
      }
      if (checkoutLocked) { event.preventDefault(); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
   }, [checkoutLocked, lastAddedShortcut, role, selectedLine, showSignIn, total, catalog.products]);
  useEffect(() => { fetch(apiUrl(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`)).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then(setCatalog).catch(() => { showSystemError("カタログを読み込めません。初期値を表示しています"); }); }, []);
  useEffect(() => {
    if (role !== "staff" || !authActor) return;
    inventoryRefreshRef.current = refreshInventory;
    refreshInventory();
    const timer = window.setInterval(refreshInventory, 10_000);
    return () => { inventoryRefreshRef.current = () => undefined; window.clearInterval(timer); };
  }, [authActor, catalog.eventId, role]);
  useEffect(() => {
    if (role !== "staff" || panel !== "products") return;
    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>(".product-grid > button")).slice(0, visibleProducts.length);
    buttons.forEach((button, index) => {
      const product = visibleProducts[index];
      if (!product) return;
      const available = inventory.get(product.productCode);
      button.querySelector(".stock-indicator")?.remove();
      button.classList.remove("stock-low", "stock-out");
      if (available === null || available === undefined) return;
      const toneClass = stockToneClass(available, stockDisplaySettings);
      if (toneClass) button.classList.add(toneClass);
      const text = stockIndicatorText(available, stockDisplaySettings);
      if (text !== null) { const indicator = document.createElement("small"); indicator.className = "stock-indicator"; indicator.textContent = text; button.append(indicator); }
    });
  }, [inventory, panel, role, stockDisplaySettings, visibleProducts]);
  useEffect(() => {
    const transactionId = serverDraft?.completedTransactionId;
    if (!transactionId) { setCurrentTransactionId(null); setCurrentPublicReference(""); setPrintJob(null); return; }
    let stopped = false; let jobId = "";
    const refreshTransaction = () => void checkoutApi.getTransaction(transactionId).then((transaction) => { if (stopped) return; setCurrentTransactionId(transactionId); setCurrentPublicReference(transaction.publicReferenceDisplay ?? ""); jobId = transaction.printJob?.jobId ?? jobId; if (jobId) return checkoutApi.getPrintJob(jobId).then((job) => { if (!stopped) setPrintJob(job); }); }).catch(() => undefined);
    refreshTransaction(); const timer = window.setInterval(() => { if (jobId) void checkoutApi.getPrintJob(jobId).then((job) => { if (!stopped) setPrintJob(job); }).catch(() => undefined); else refreshTransaction(); }, 1000);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [serverDraft?.completedTransactionId]);
  useEffect(() => { let stopped = false; const poll = () => { void fetch(apiUrl("/api/v1/emergency-alerts/latest"), { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as { alert: EmergencyAlert | null } : null).then((result) => { const alert = result?.alert; if (stopped || !alert || alert.id === lastEmergencyAlertIdRef.current) return; lastEmergencyAlertIdRef.current = alert.id; setEmergencyAlert(alert); speakEmergencyAlertReceived(routedSpeech); }).catch(() => { /* 次回のポーリングで復旧する */ }); }; poll(); const timer = window.setInterval(poll, 1000); return () => { stopped = true; window.clearInterval(timer); }; }, [routedSpeech]);
  const saveCatalog = async (next: EventCatalog) => { await checkoutApi.saveCatalog(next.eventId, JSON.parse(exportEventCatalog(next))); setCatalog(next); };
  const highlightLine = (productCode: string, state: "active" | "cancelled" = "active", animation: LineAnimationKind = state === "cancelled" ? "cancel" : "update") => { const highlightKey = `${state}:${productCode}`; triggerHighlight(highlightKey, animation); localStorage.setItem(storageKey("line-highlight"), JSON.stringify({ highlightKey, productCode, animation, at: Date.now() })); };
  function applyLastAddedQuantityShortcut() {
    const shortcut = lastAddedShortcut;
    if (!shortcut?.eligible || checkoutLocked || draftRef.current?.state === "completed") return false;
    const line = cart.find((candidate) => candidate.lineId === shortcut.lineId);
    if (!line || line.cancelled || !line.lineId) return false;
    void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, line.lineId!, draft.version, { quantity: 4 })).then((next) => {
      if (!next) return;
      setLastAddedShortcut({ lineId: shortcut.lineId, eligible: false });
      triggerHighlight(`active:${line.product.productCode}`, "quantity");
    });
    return true;
  }
  useEffect(() => {
    if (panel !== "detail" || !highlighted) return;
    const productCode = highlighted.slice(highlighted.indexOf(":") + 1);
    const row = Array.from(detailPanelRef.current?.querySelectorAll<HTMLElement>(".detail-row[data-product-code]") ?? []).find((candidate) => candidate.dataset.productCode === productCode);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlighted, panel, cart.length]);
  useEffect(() => {
    if (!lastAddedShortcut?.eligible) return;
    const line = cart.find((candidate) => candidate.lineId === lastAddedShortcut.lineId);
    if (!line || line.cancelled) setLastAddedShortcut({ lineId: lastAddedShortcut.lineId, eligible: false });
  }, [cart, lastAddedShortcut]);
  const addProduct = (product: ProductDefinition, quantity = 1, announce = true, ageCheckBypass = false, startedNextTransaction = false) => {
    setCancelFeedback(null);
    if ((checkoutLocked || draftRef.current?.state === "completed") && !startedNextTransaction) { void startNextTransaction().then((ready) => { if (ready) addProduct(product, quantity, announce, ageCheckBypass, true); }); return; }
    if (product.saleState !== "on_sale") return showOperationError("この商品は販売停止中のため登録できません。");
    const requiredAge = ageRequirement(product);
    if (!ageCheckBypass && requiredAge && (!ageVerified || ageVerifiedMinimum < requiredAge)) {
      setAgeProduct(product); setAgeFlowState("customer_pending"); setAgeConfirmationRequest(null);
      const pendingRequest = openDraft()
        .then((draft) => checkoutApi.createAgeConfirmationRequest(registerId, draft.draftId, requiredAge))
        .then(({ requestId }) => {
          if (staffAgeRequestRef.current?.id === pendingRequest) speakAgeCheckRequired(routedSpeech);
          return requestId;
        })
        .catch((error) => {
          if (staffAgeRequestRef.current?.id === pendingRequest) {
            staffAgeRequestRef.current = null;
            setAgeProduct(null);
            setAgeFlowState("idle");
            showSystemError(errorMessage(error), error);
          }
          return null;
        });
      staffAgeRequestRef.current = { id: pendingRequest, confirming: false };
      return;
    }
    void runDraftMutation((draft) => checkoutApi.addLine(draft.draftId, draft.version, product.productCode, quantity)).then((next) => { if (!next) return; const line = [...next.lines].reverse().find((candidate) => candidate.productCode === product.productCode && candidate.status === "active"); setRecentAddedProducts((current) => [{ id: Date.now(), product, quantity }, ...current].slice(0, 6)); setLastAddedShortcut(line ? { lineId: line.lineId, eligible: true } : null); playOperationSound("register", audioSettings.tapVolume); highlightLine(product.productCode, "active", "add"); if (announce) speakProductPrice(routedSpeech, formatJapaneseYenSpeech(product.priceInclTax)); });
  };
  const submitUnknownProduct = () => {
    if (!pendingUnknownProduct) return;
    const priceInclTax = Number(pendingUnknownProduct.priceInput);
    if (!/^\d+$/.test(pendingUnknownProduct.priceInput) || !Number.isSafeInteger(priceInclTax)) return showOperationError("税込価格を整数で入力してください。");
    setPendingUnknownProduct((current) => current ? { ...current, saving: true } : current);
    void runDraftMutation((draft) => checkoutApi.addUnregisteredLine(draft.draftId, draft.version, { productCode: pendingUnknownProduct.code, priceInclTax, taxRate: pendingUnknownProduct.taxRate })).then((next) => {
      if (!next) { setPendingUnknownProduct((current) => current ? { ...current, saving: false } : current); return; }
      setPendingUnknownProduct(null); setPendingBook(null); setScanNotice("");
      const line = [...next.lines].reverse().find((candidate) => candidate.productCode === pendingUnknownProduct.code && candidate.status === "active");
      setLastAddedShortcut(line ? { lineId: line.lineId, eligible: true } : null); playOperationSound("register", audioSettings.tapVolume); if (line) highlightLine(line.productCode, "active", "add"); speakProductPrice(routedSpeech, formatJapaneseYenSpeech(priceInclTax));
    });
  };
  const handleBarcode = (raw: string) => {
    const classification = classifyScan(raw);
    if (classification.kind === "parked-draft") { if (!classification.parkReference) return showOperationError("保留受付番号が空です。"); resumeParkedDraft(classification.parkReference); return; }
    if (classification.kind === "hold") { if (!classification.reference) return showOperationError("取り置き受付番号が空です。"); setHoldSearchReference(classification.reference); setShowHoldOperations(true); return; }
    if (classification.kind === "transaction") {
      if (!classification.reference) return showOperationError("取引受付番号が空です。");
      if (classification.businessDate && /^\d{14}$/.test(raw.trim()) && validatePublicReference(classification.reference)) {
        const year = Number(classification.businessDate.slice(0, 4)); const month = Number(classification.businessDate.slice(5, 7)); const day = Number(classification.businessDate.slice(8, 10));
        const parsedDate = new Date(Date.UTC(year, month - 1, day));
        if (parsedDate.getUTCFullYear() === year && parsedDate.getUTCMonth() === month - 1 && parsedDate.getUTCDate() === day) {
          setReturnReference(raw.trim()); setShowReturnOperations(true); setScanNotice("返品バーコードを読み取りました。元売上を検索します。"); return;
        }
      }
      setJournalReference(classification.reference); setJournalDate(classification.businessDate); setShowJournal(true); return;
    }
    const parsed = parseBarcode(raw);
    if (parsed.kind === "payment-slip" && parsed.paymentSlip) {
      setScanNotice("払込票を確認しました。リマインダーレシートを発行します（収納処理は行いません）。");
      void checkoutApi.createPaymentSlipReminder(raw, registerId).then(() => setScanNotice(`払込票リマインダーを印刷待ちにしました。期限：${parsed.paymentSlip!.dueDate.kind === "date" ? parsed.paymentSlip!.dueDate.isoDate : "設定なし"}／${parsed.paymentSlip!.amount.toLocaleString()}円`)).catch((error) => showSystemError(errorMessage(error), error));
      return;
    }
    if (parsed.kind === "book-price" && parsed.bookPrice) {
      setPendingBook((current) => ({ ...current, priceCode: parsed.normalized }));
      const detail = `書籍JAN下段：${parsed.bookPrice.cCode}（${parsed.bookPrice.salesTarget}・${parsed.bookPrice.publicationForm}・${parsed.bookPrice.subject}）／税抜${parsed.bookPrice.priceExclTaxYen.toLocaleString()}円。`;
      if (pendingBook?.isbn) { setPendingBook(null); setScanNotice(`${detail}上下段を確認済みです。1冊として商品登録しました。`); }
      else setScanNotice(`${detail}上段ISBNを読み取ってください。`);
      return;
    }
    if (parsed.kind === "periodical" && parsed.periodical) {
      const info = parsed.periodical;
      if (info.priceExclTaxYen === null) return showOperationError(`定期刊行物JAN：雑誌コード ${info.magazineCode}／${info.issueLabel}。本体価格がバーコード上で0000のため、売価を確定できません。商品マスタから登録してください。`);
      const priceInclTaxYen = info.priceExclTaxYen + Math.floor(info.priceExclTaxYen * 0.1);
      setScanNotice(`定期刊行物JAN：雑誌コード ${info.magazineCode}／${info.issueLabel}／税抜${info.priceExclTaxYen.toLocaleString()}円（税込${priceInclTaxYen.toLocaleString()}円）。この18桁の号を登録します。`);
      void runDraftMutation((draft) => checkoutApi.addPeriodicalLine(draft.draftId, draft.version, parsed.normalized)).then((next) => { if (!next) return; const line = [...next.lines].reverse().find((candidate) => candidate.status === "active" && candidate.name === `定期刊行物 ${info.magazineCode} ${info.issueLabel}`); setLastAddedShortcut(line ? { lineId: line.lineId, eligible: true } : null); playOperationSound("register", audioSettings.tapVolume); if (line) highlightLine(line.productCode, "active", "add"); });
      return;
    }
    const productCode = parsed.gtin;
    if (parsed.kind === "book-isbn") {
      setPendingBook((current) => ({ ...current, isbn: parsed.normalized }));
      setScanNotice(pendingBook?.priceCode ? "書籍JANの上下段を確認しました。1冊として商品登録します。" : "書籍JAN上段（ISBN）を読み取りました。下段の分類・価格コードも読み取ってください。商品登録します。 ");
    }
    const product = productCode ? catalog.products.find((candidate) => candidate.productCode === productCode) : undefined;
    if (product) { addProduct(product); if (parsed.kind === "book-isbn" && pendingBook?.priceCode) setPendingBook(null); return; }
    if (productCode && (parsed.kind === "gtin" || parsed.kind === "book-isbn")) { setPendingUnknownProduct({ code: productCode, priceInput: "", taxRate: 10, saving: false }); setScanNotice(`未登録商品 ${productCode} です。税込価格を入力してください。`); return; }
    if (parsed.kind === "unknown") return showOperationError(parsed.error ?? "対応していないバーコードです。");
    showOperationError("商品コードが見つかりません。商品マスタへ登録してください。");
  };
  const addQuick = (quick: QuickEntry, startedNextTransaction = false) => {
    setCancelFeedback(null);
    if ((checkoutLocked || draftRef.current?.state === "completed") && !startedNextTransaction) { void startNextTransaction().then((ready) => { if (ready) addQuick(quick, true); }); return; }
    const components = quick.productCode ? [{ productCode: quick.productCode, quantity: quick.quantity ?? 1 }] : (quick.components ?? []);
    const restricted = components.map((component) => catalog.products.find((item) => item.productCode === component.productCode)).find((product) => product && isAgeRestricted(product) && (!ageVerified || ageVerifiedMinimum < (ageRequirement(product) ?? 20)));
    if (restricted) { addProduct(restricted, components.find((component) => component.productCode === restricted.productCode)?.quantity ?? 1, false, false, startedNextTransaction); return; }
    const addedTotal = components.reduce((sum, component) => sum + (catalog.products.find((product) => product.productCode === component.productCode)?.priceInclTax ?? 0) * component.quantity, 0);
    const operation = quick.components ? (draft: CheckoutDraft) => checkoutApi.addBundle(draft.draftId, draft.version, quick.id) : (draft: CheckoutDraft) => checkoutApi.addLine(draft.draftId, draft.version, quick.productCode!, quick.quantity ?? 1);
     void runDraftMutation(operation).then((next) => { if (!next) return; setLastAddedShortcut(null); const line = [...next.lines].reverse().find((candidate) => candidate.status === "active"); if (line) highlightLine(line.productCode, "active", "add"); if (addedTotal > 0) { playOperationSound("register", audioSettings.tapVolume); speakProductPrice(routedSpeech, formatJapaneseYenSpeech(addedTotal)); } });
  };
  const setQuantity = (lineIndex: number) => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。数量は変更できません。"); const line = cart[lineIndex]; if (!line?.lineId) return; setQuantityInput(String(line.quantity)); setQuantityEditLine(line); };
  const signOut = () => { if (activeCart.length > 0) return showOperationError("登録中の商品があるため責任者を解除できません。登録を完了または中止してください。"); void checkoutApi.signOut().catch(() => undefined).finally(() => { setShowBusinessMenu(false); setResponsibleNumber(""); setSignedInResponsibleNumber("---"); setSignedInUser("---"); setAuthActor(null); setBusinessSession(null); setRegisterState(null); setShowSignIn(true); }); };
  const signIn = () => {
    const normalized = normalizeResponsibleNumber(responsibleNumber);
    if (!normalized) return showOperationError("責任者番号を入力してください。");
    setLifecycleLoading(true); setLifecycleError("");
    void checkoutApi.signIn(catalog.eventId, normalized, registerId).then((actor) => { setResponsibleNumber(normalized); setSignedInResponsibleNumber(actor.responsibleNumber); setSignedInUser(actor.displayName); setAuthActor(actor); setShowSignIn(false); }).catch((error) => setLifecycleError(errorMessage(error))).finally(() => setLifecycleLoading(false));
  };
  const cancelRegistration = () => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。登録中止はできません。"); const draft = draftRef.current; if (!draft) return; void checkoutApi.cancelDraft(draft.draftId, draft.version).then((next) => { const request = staffAgeRequestRef.current ? null : ageConfirmationRequest; applyDraft(next); if (request) return checkoutApi.cancelAgeConfirmationRequest(registerId, request.requestId); }).catch((error) => showSystemError(errorMessage(error), error)); };
  const selectedLineItem = selectedLine !== null ? cart[selectedLine] : undefined;
  const selectedLineCalculation = selectedLineItem?.lineId ? serverDraft?.calculation.lines.find((line) => line.lineId === selectedLineItem.lineId) : undefined;
  const selectedLineAmount = selectedLineCalculation?.netYen ?? (selectedLineItem ? selectedLineItem.product.priceInclTax * selectedLineItem.quantity : 0);
  const lastAddedEntry = recentAddedProducts[0];
  const lastAddedLine = lastAddedEntry ? activeCart.find((line) => line.product.productCode === lastAddedEntry.product.productCode) : undefined;
  const lastAddedQuantity = lastAddedLine?.quantity ?? lastAddedEntry?.quantity ?? 0;
  const lastAddedAmount = (lastAddedLine?.lineId ? serverDraft?.calculation.lines.find((line) => line.lineId === lastAddedLine.lineId)?.netYen : undefined) ?? (lastAddedEntry ? lastAddedEntry.product.priceInclTax * lastAddedQuantity : 0);
  const paymentSummaryVisible = showPayment || paymentFinished;
  const finishSelectedLineDeletion = (line: CartLine | undefined) => {
    if (!line?.lineId) return;
    const amountYen = serverDraft?.calculation.lines.find((item) => item.lineId === line.lineId)?.netYen ?? line.product.priceInclTax * line.quantity;
    void runDraftMutation((draft) => checkoutApi.cancelLine(draft.draftId, line.lineId!, draft.version)).then((next) => {
      if (!next) return;
      playOperationSound("cancel", audioSettings.tapVolume);
      highlightLine(line.product.productCode, "cancelled");
      setCancelFeedback({ product: line.product, quantity: line.quantity, amountYen });
      setSelectedLine(null);
    });
  };
  const priceChangePreview = (() => { if (!selectedLineItem || !discountMode || !discountInput) return null; const value = Number(discountInput); if (!Number.isSafeInteger(value) || value < 0) return null; return discountMode === "percent" ? (value <= 100 ? Math.floor(selectedLineItem.product.priceInclTax * (100 - value) / 100) : null) : (value <= selectedLineItem.product.priceInclTax ? selectedLineItem.product.priceInclTax - value : null); })();
  const closePriceChange = () => { setShowPriceChange(false); setDiscountMode(null); setDiscountInput(""); };
   const applySelectedDiscount = () => { if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。売価・値引きは変更できません。"); if (!selectedLineItem?.lineId || selectedLine === null || priceChangePreview === null || !discountMode) return showOperationError(discountMode === "percent" ? "値引率は0～100％で入力してください。" : "値引額は現在の単価以下で入力してください。"); const value = Number(discountInput); void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, selectedLineItem.lineId!, draft.version, { manualDiscount: { kind: discountMode === "percent" ? "rate" : "amount", value } })).then((next) => { if (!next) return; highlightLine(selectedLineItem.product.productCode, selectedLineItem.cancelled ? "cancelled" : "active"); closePriceChange(); setSelectedLine(null); }); };
  useEffect(() => { if (!showPriceChange) return; const onDiscountKey = (event: KeyboardEvent) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setDiscountInput((current) => `${current}${event.key}`.replace(/^0+(?=\d)/, "").slice(0, 7)); } else if (event.key === "Backspace") { event.preventDefault(); setDiscountInput((current) => current.slice(0, -1)); } else if (event.key === "Escape") { event.preventDefault(); closePriceChange(); } else if (event.key === "Enter" && discountMode) { event.preventDefault(); applySelectedDiscount(); } }; window.addEventListener("keydown", onDiscountKey); return () => window.removeEventListener("keydown", onDiscountKey); }, [showPriceChange, discountMode, discountInput, priceChangePreview, selectedLine]);
  const closeAgeConfirmation = () => {
    const pendingRequest = staffAgeRequestRef.current;
    staffAgeRequestRef.current = null;
    setAgeFlowState("idle");
    setAgeConfirmationRequest(null);
    setAgeProduct(null);
    void pendingRequest?.id.then((requestId) => {
      if (requestId) return checkoutApi.cancelAgeConfirmationRequest(registerId, requestId);
    }).catch((error) => showSystemError(errorMessage(error), error));
  };
  const confirmAge = async () => {
    if (checkoutLocked || draftRef.current?.state === "completed") return showOperationError("この取引は会計済みです。年齢確認は変更できません。");
    const product = ageProduct;
    const pendingRequest = staffAgeRequestRef.current;
    if (!product || !pendingRequest || pendingRequest.confirming) return;
    pendingRequest.confirming = true;
    if (!(await pendingRequest.id) || staffAgeRequestRef.current !== pendingRequest) return;
    const verifiedMinimum = ageRequirement(product) ?? 20;
    const next = await runDraftMutation(async (draft) => {
      const verified = await checkoutApi.addAgeVerification(draft.draftId, draft.version, { minimumAge: verifiedMinimum, method: "id_visual", result: "passed", confirmerId: signedInResponsibleNumber, terminalId: registerId });
      return checkoutApi.addLine(verified.draftId, verified.version, product.productCode, 1);
    });
    if (!next) { pendingRequest.confirming = false; return; }
    const line = [...next.lines].reverse().find((candidate) => candidate.productCode === product.productCode && candidate.status === "active");
    if (staffAgeRequestRef.current === pendingRequest) closeAgeConfirmation();
    setAgeVerified(true);
    setAgeVerifiedMinimum(verifiedMinimum);
    setLastAddedShortcut(line ? { lineId: line.lineId, eligible: true } : null);
    playOperationSound("register", audioSettings.tapVolume);
    if (line) highlightLine(line.productCode, "active", "add");
    speakProductPrice(routedSpeech, formatJapaneseYenSpeech(product.priceInclTax));
  };
  const updateAudioSetting = (key: "tapVolume" | "errorVolume" | "systemErrorVolume" | "speechVolume" | "speakerId", value: number) => {
    const requested = normalizeAudioSettings({ ...audioSettings, [key]: value });
    setAudioSettings(requested);
    void checkoutApi.saveAudioSettings(registerId, requested).then((savedValue) => {
      const saved = normalizeAudioSettings(savedValue);
      setAudioSettings((current) => {
        const valueHasChanged = current[key] !== requested[key];
        if (valueHasChanged) return { ...current, version: Math.max(current.version, saved.version) };
        return saved.version >= current.version ? saved : current;
      });
    }).catch((error) => showSystemError(errorMessage(error), error));
  };
  const updateStockDisplaySetting = (key: keyof StockDisplaySettings, value: boolean) => {
    const next = normalizeStockDisplaySettings({ ...stockDisplaySettings, [key]: value });
    setStockDisplaySettings(next);
    storeStockDisplaySettings(registerNumber, next);
  };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).catch((error) => showSystemError(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { showOperationError(error instanceof Error ? error.message : "JSONが不正です"); } };
  const inputAmount = /^[0-9]+$/.test(inputBuffer) ? Number(inputBuffer) : null;
  const customerCheckoutStatus = paymentFinished ? (completedPaymentLabel === "現金" ? `お預り ${received.toLocaleString()}円　お釣り ${Math.max(0, received - total).toLocaleString()}円` : `支払方法 ${completedPaymentLabel}　会計済み`) : showPayment ? (inputAmount !== null ? `お預り入力 ${inputAmount.toLocaleString()}円` : "お支払いをお願いします") : null;
  const displayDiscounts = role === "customer" ? projectedDiscounts : (serverDraft?.calculation.discounts.map((discount) => ({ label: discount.label, amountYen: discount.amountYen })) ?? autoDiscounts.map((discount) => ({ label: `${discount.label}${discount.applications > 1 ? ` ×${discount.applications}` : ""}`, amountYen: discount.discountYen })));
   const isLineHighlighted = (line: { product: ProductDefinition; cancelled?: boolean }) => highlighted === `${line.cancelled ? "cancelled" : "active"}:${line.product.productCode}`;
   const lineClassName = (line: { product: ProductDefinition; cancelled?: boolean }) => `${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? `line-highlight line-animation-${highlightAnimation}` : ""}`;
   const isQuantityAnimated = (line: { product: ProductDefinition; cancelled?: boolean }) => isLineHighlighted(line) && highlightAnimation === "quantity";
   const emergencyModal = emergencyAlert && <div className="modal-backdrop emergency-layer"><section className="emergency-modal" role="alertdialog" aria-modal="true"><h2>緊急情報</h2><h3>{emergencyAlert.title}</h3><p>{emergencyAlert.message}</p><small>受信時刻 {new Date(emergencyAlert.receivedAt).toLocaleString("ja-JP")}</small><button onClick={() => setEmergencyAlert(null)}>確認</button></section></div>;
   const supplementalUi = <>
     {showParkedDrafts && <div className="modal-backdrop"><section className="parked-drafts-modal"><header><h2>保留／呼戻</h2><button onClick={() => setShowParkedDrafts(false)}>閉じる</button></header><section className="parked-draft-current" aria-label="現在の会計を保留"><h3>現在の会計</h3>{activeCart.length > 0 && !checkoutLocked ? <button onClick={() => parkCurrentDraft(() => setShowParkedDrafts(false))}>この会計を保留する</button> : activeCart.length === 0 ? <small>保留できる明細がありません。</small> : null}</section>{parkedDraftsLoading && <p>読み込み中…</p>}{!parkedDraftsLoading && parkedDrafts.length === 0 && <p>保留中の会計はありません。</p>}{parkedDrafts.map((parked) => <div className="parked-draft-row" key={parked.draftId}><div><strong>{parked.parkReferenceDisplay}</strong><span>{parked.lineCount}点／{parked.totalYen.toLocaleString()}円</span><small>{new Date(parked.createdAt).toLocaleString("ja-JP")}</small></div><button onClick={() => resumeParkedDraft(parked.parkReference)}>呼び戻す</button></div>)}</section></div>}
     {showOfficialReceipt && <div className="modal-backdrop"><form className="official-receipt-modal" onSubmit={(event) => { event.preventDefault(); issueOfficialReceipt(); }}><h2>領収書を発行</h2><p>宛名・但し書きは、印刷された領収書に手書きで記入してください。</p><div><button type="submit" disabled={officialReceiptBusy}>{officialReceiptBusy ? "発行中…" : "発行する"}</button><button type="button" onClick={() => setShowOfficialReceipt(false)}>戻る</button></div></form></div>}
   </>;
   const training = isTrainingMode();
   if (role === "customer") return <main className={`pos-screen customer-screen${training ? " training-mode" : ""}`}>{training && TRAINING_BANNER}<section className="customer-lines">{(customerAgeNotice || customerRequiresAge) && <div className={`age-notice ${customerAgeNotice === "verified" ? "" : "customer-age-prompt"} ${customerAgeNotice ?? "required"}`}><strong>{customerAgeNotice === "verified" ? `年齢確認済み（${customerAgeMinimum}歳以上）` : `あなたは${customerAgeMinimum}歳以上ですか？`}</strong>{customerAgeNotice !== "verified" && <button className="customer-age-yes" onPointerUp={() => { if (!ageConfirmationRequest || ageConfirmationRequest.state !== "requested") return; void checkoutApi.acknowledgeAgeConfirmation(terminalId, registerId, ageConfirmationRequest.requestId).then(() => { setCustomerAgeAcknowledged(true); setCustomerAgeNotice("verified"); speakIdentityMayBeRequested(speech); }).catch((error) => showSystemError(errorMessage(error))); }}>はい</button>}</div>}{cart.length === 0 ? <div className="customer-empty customer-welcome">{catalog.customerWelcome?.imageUrl && <img src={catalog.customerWelcome.imageUrl} alt="" />}{catalog.customerWelcome?.circleName && <strong>{catalog.customerWelcome.circleName}</strong>}{catalog.customerWelcome?.space && <span>{catalog.customerWelcome.space}</span>}<p>{catalog.customerWelcome?.message ?? "いらっしゃいませ"}</p></div> : <><div className="customer-line customer-line-head"><span>商品名</span><span>税区分</span><span>点数</span></div>{cart.map((line, index) => <div data-product-code={line.product.productCode} className={`customer-line ${lineClassName(line)}`} key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>{taxCategoryLabel(line.product.taxCategory)}</span><span>{isQuantityAnimated(line) ? <span className="line-quantity-change">{line.quantity}</span> : line.quantity}点</span></div>)}</>}{displayDiscounts.map((discount, index) => <div className="customer-discount" key={`${discount.label}-${index}`}><span>{discount.label}</span><strong>-{discount.amountYen.toLocaleString()}円</strong></div>)}</section><footer className="customer-total"><span>{customerCheckoutStatus ?? `合計 ${activeCart.reduce((sum, line) => sum + line.quantity, 0)}点`}</span><strong>{total.toLocaleString()}円</strong></footer>{emergencyModal}</main>;
  if (!authActor || !businessSession || registerState?.state !== "open") return <main className={`pos-screen lifecycle-shell${training ? " training-mode" : ""}`}>
    {training && TRAINING_BANNER}
    <header className="lifecycle-header"><strong>ぽすりん</strong>{training && <span className="training-mode-badge">トレーニング</span>}<span>{catalog.eventId}</span><span>{registerId}</span><span className={serverOnline ? "status-online" : "status-offline"}>{serverOnline ? "サーバー接続" : "サーバー未接続"}</span><a className="lifecycle-top-link" href="/">トップページへ</a></header>
    <section className="lifecycle-card" aria-live="polite">
      {authActor && (businessSession?.state === "closed" ? <><p className="lifecycle-kicker">営業終了</p><h1>精算が全レジで終了しました。お疲れ様でした。気をつけてお帰りください</h1><p>責任者のサインオン状態は失効しました。この画面を閉じるか、次の営業で改めてサインオンしてください。</p></> : !businessSession ? <><p className="lifecycle-kicker">未開局</p><h1>営業全体が未開局です</h1><p>{authActor.displayName}（{authActor.role}）でサインオン中です。営業日を確認して開局してください。</p><button disabled={lifecycleLoading} onClick={() => { setLifecycleLoading(true); void checkoutApi.openBusinessSession(catalog.eventId, localBusinessDate(), registerId).then((session) => { setBusinessSession(session); setLifecycleError(""); }).catch((error) => setLifecycleError(errorMessage(error))).finally(() => setLifecycleLoading(false)); }}>営業全体を開局する</button></> : !registerState ? <><p className="lifecycle-kicker">営業全体開局済み</p><h1>レジの準備を開始してください</h1><p>営業セッション {businessSession.sessionNo}／営業日 {businessSession.businessDate}</p><button disabled={lifecycleLoading} onClick={() => { setLifecycleLoading(true); void checkoutApi.prepareRegister(businessSession.businessSessionId, registerId, terminalId).then(() => refreshLifecycle()).then(() => setShowCashOperations(true)).catch((error) => setLifecycleError(errorMessage(error))).finally(() => setLifecycleLoading(false)); }}>レジ準備を開始する</button></> : <><p className="lifecycle-kicker">レジ精算</p><h1>{registerState.state === "closed" ? "このレジは精算済みです" : "準備金を入力してください"}</h1><p>{registerState.state === "closed" ? "営業全体はまだ開局中です。最後のレジ精算後は、責任者が営業を終了してください。" : "準備金の金種別実査が確定するまで、商品登録と会計操作は停止しています。"}</p>{registerState.state === "preparing" && <button onClick={() => setShowCashOperations(true)}>準備金入力を開く</button>}{registerState.state === "closed" && (authActor.role === "manager" || authActor.role === "admin") && <button className="cash-danger" disabled={lifecycleLoading} onClick={() => { setLifecycleLoading(true); setLifecycleError(""); void checkoutApi.closeBusinessSession(businessSession.businessSessionId, terminalId).then((session) => { setBusinessSession(session); }).catch((error) => setLifecycleError(errorMessage(error))).finally(() => setLifecycleLoading(false)); }}>営業を終了する</button>}</>)}
      {lifecycleLoading && <p>状態を確認しています…</p>}{lifecycleError && <p className="lifecycle-error" role="alert">{lifecycleError}</p>}
      {authActor && !businessSession && authActor.role === "admin" && <button className="lifecycle-secondary" disabled={lifecycleLoading} onClick={() => { setLifecycleLoading(true); void checkoutApi.reloadCatalog(catalog.eventId).then((result) => { setCatalog(result.catalog as EventCatalog); setLifecycleError("YAML設定を再読み込みしました。内容を確認してから開局してください。"); }).catch((error) => setLifecycleError(errorMessage(error))).finally(() => setLifecycleLoading(false)); }}>YAML設定を再読み込み</button>}
      {authActor && <button className="lifecycle-secondary" onClick={signOut}>サインオフ</button>}
    </section>
    {!authActor && <div className="modal-backdrop lifecycle-sign-in-backdrop"><form className="modal lifecycle-sign-in-modal" onSubmit={(event) => { event.preventDefault(); signIn(); }}><h2>サインオン（責任者入力）</h2><p>開局前の操作には責任者のサインオンが必要です。</p><label>3桁責任者番号<input aria-label="責任者番号" inputMode="numeric" autoFocus maxLength={3} placeholder="責任者番号" value={responsibleNumber} onChange={(event) => setResponsibleNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /></label><button type="submit" disabled={lifecycleLoading}>サインオン</button>{lifecycleError && <p className="lifecycle-error" role="alert">{lifecycleError}</p>}</form></div>}
    {showCashOperations && businessSession && <CashOperations eventId={catalog.eventId} businessSessionId={businessSession.businessSessionId} businessDate={businessSession.businessDate} cashboxId={registerId} actorId={signedInResponsibleNumber} terminalId={registerId} onClose={() => { setShowCashOperations(false); void refreshLifecycle(); }} />}
    {emergencyModal}
  </main>;
  return <main className={`pos-screen register-shell${training ? " training-mode" : ""}`}>
    {training && TRAINING_BANNER}
    <RegisterHeader businessSession={businessSession} scanNotice={scanNotice} signedInUser={signedInUser} canOpenDrawer={staffPermissions.has("reprint")} onOpenBusinessMenu={() => setShowBusinessMenu(true)} onOpenDrawer={() => void checkoutApi.openDrawer(signedInResponsibleNumber).catch((error) => showSystemError(errorMessage(error), error))} onSignOut={signOut} training={training} />
    {panel === "products" ? <section className="product-panel"><aside className="mini-cart"><button className="panel-switch" onClick={() => setPanel("detail")}>登録明細へ</button><div className="mini-cart-table"><div className="mini-cart-head"><span>No.</span><span>商品名</span><span className="numeric-column">金額</span></div><div className="mini-cart-lines">{cart.length === 0 ? <div className="mini-cart-empty">{EMPTY_DETAIL_MESSAGE}</div> : cart.map((line, index) => { const calculation = serverDraft?.calculation.lines.find((item) => item.lineId === line.lineId); const discountYen = calculation?.discountYen ?? 0; const amountYen = calculation?.netYen ?? line.product.priceInclTax * line.quantity; return <div role="button" tabIndex={0} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`mini-cart-line ${selectedLine === index ? "selected-line" : ""} ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><div className="mini-cart-item-name"><span>{index + 1}.</span><strong>{line.product.name}</strong></div><div className="mini-cart-item-detail"><span>{line.quantity}点 × {line.product.priceInclTax.toLocaleString()}円</span>{discountYen > 0 && <span className="mini-cart-item-discount">値引き -{discountYen.toLocaleString()}円</span>}</div><strong className="mini-cart-item-amount">{amountYen.toLocaleString()}円</strong></div>; })}</div><footer><span>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></div></aside><div className="product-picker"><div className="product-tabs"><button className={productTab === "all" ? "active" : ""} onClick={() => setProductTab("all")}>すべて</button>{(catalog.productTabs ?? []).map((tab) => <button key={tab.id} className={productTab === tab.id ? "active" : ""} style={tab.color ? { backgroundColor: tab.color } : undefined} onClick={() => setProductTab(tab.id)}>{tab.label}</button>)}<button className={`business-tab ${productTab === "business" ? "active" : ""}`} onClick={() => setProductTab("business")}>業務</button></div>{productTab === "business" ? <section className="business-panel" aria-label="業務"><h2>業務</h2><div className="business-action-grid"><button onClick={() => { setShowParkedDrafts(true); refreshParkedDrafts(); }}><strong>保留／呼戻</strong><span>現在の会計を保留する／保留中の会計を呼び戻す</span></button><button disabled={!currentTransactionId || !checkoutLocked} onClick={() => setShowOfficialReceipt(true)}><strong>領収書を発行</strong><span>{currentTransactionId && checkoutLocked ? "確定済みの取引から発行" : "会計を確定すると発行できます"}</span></button><button disabled={!currentTransactionId || !printJob || !staffPermissions.has("reprint")} onClick={() => { if (!currentTransactionId || !printJob) return showOperationError("会計済み取引の印刷jobを取得してから再印刷してください。"); setShowReprint(true); }}><strong>再印刷</strong><span>{!staffPermissions.has("reprint") ? "権限が必要です" : currentTransactionId && printJob ? "確定済みの取引を再印刷" : "会計済み取引と印刷jobが必要です"}</span></button><button onClick={() => setShowJournal(true)}><strong>ジャーナル参照</strong><span>確定済みの取引を検索・確認する</span></button><button disabled={!canCancelRegistration} onClick={() => { if (canCancelRegistration) setCancelConfirm(true); }}><strong>登録中止</strong><span>{canCancelRegistration ? "現在の会計を中止する" : "登録中の明細がありません"}</span></button></div></section> : <div className="product-grid">{visibleProducts.map((product) => { const registeredQuantity = activeCart.filter((line) => line.product.productCode === product.productCode).reduce((sum, line) => sum + line.quantity, 0); const tabLabel = catalog.productTabs?.find((tab) => tab.id === product.tabId)?.label ?? "商品"; return <button key={product.productCode} disabled={product.saleState !== "on_sale"} style={product.displayColor ? { backgroundColor: product.displayColor } : undefined} onClick={() => addProduct(product)}>{product.thumbnailUrl && <img className="product-thumbnail" src={product.thumbnailUrl} alt="" />}<span className="product-card-badge">{registeredQuantity > 0 ? `登録中 ${registeredQuantity}点` : tabLabel}</span><strong className="product-card-name"><span className="product-card-name-text">{product.name}</span></strong><span className="product-card-price">{product.priceInclTax.toLocaleString()}円</span></button>})}{catalog.quickEntries.map((quick) => { const quickProduct = quick.productCode ? catalog.products.find((product) => product.productCode === quick.productCode) : undefined; return <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><span className="product-card-badge">クイック</span><strong className="product-card-name"><span className="product-card-name-text">{quick.label}</span></strong>{quickProduct && <span className="product-card-price">{(quickProduct.priceInclTax * (quick.quantity ?? 1)).toLocaleString()}円</span>}</button>; })}</div>}</div></section> : <section className="detail-view"><button className="panel-switch" onClick={() => setPanel("products")}>商品登録へ</button><div ref={detailPanelRef} className="detail-panel"><DetailHeader />{cart.map((line, index) => { const calculation = serverDraft?.calculation.lines.find((item) => item.lineId === line.lineId); return <div role="button" tabIndex={0} data-product-code={line.product.productCode} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`detail-row ${selectedLine === index ? "selected-line" : ""} ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>{taxCategoryLabel(line.product.taxCategory)}</span><strong>{line.product.name}</strong><span className="numeric-column">{line.quantity}</span><span className="numeric-column">{line.product.priceInclTax.toLocaleString()}円</span><span className="numeric-column">-{(calculation?.discountYen ?? 0).toLocaleString()}円</span><span className="numeric-column amount-column">{(calculation?.netYen ?? line.product.priceInclTax * line.quantity).toLocaleString()}円</span><span className="row-action-hint">選択中</span></div>})}{cart.length === 0 && <div className="empty-detail">{EMPTY_DETAIL_MESSAGE}</div>}</div></section>}
     <section className="staff-bottom"><div className="last-added">{cancelFeedback ? <><span className="selection-kicker">取り消しました</span><strong className="cancel-feedback-line">{cancelFeedback.product.name}</strong><div className="selected-line-summary cancel-feedback-line"><span>{cancelFeedback.quantity}点 × {cancelFeedback.product.priceInclTax.toLocaleString()}円</span><strong>{cancelFeedback.amountYen.toLocaleString()}円</strong></div></> : selectedLineItem && selectedLine !== null ? <><span className="selection-kicker">選択中商品</span><strong>{selectedLineItem.product.name}</strong><div className="selected-line-summary"><span>{selectedLineItem.quantity}点 × {selectedLineItem.product.priceInclTax.toLocaleString()}円</span><strong>{selectedLineAmount.toLocaleString()}円</strong></div><div className="selected-line-actions"><button disabled={checkoutLocked || selectedLineItem.cancelled} onClick={() => setQuantity(selectedLine)}>数量変更</button><button disabled={checkoutLocked || selectedLineItem.cancelled} onClick={() => setShowPriceChange(true)}>値引き</button><button className="danger-action" disabled={checkoutLocked || selectedLineItem.cancelled} onClick={() => finishSelectedLineDeletion(selectedLineItem)}>取り消し</button><button className="secondary-action" onClick={() => setSelectedLine(null)}>選択解除</button></div></> : checkoutLocked ? <><span className="selection-kicker">会計完了</span><strong>次の取引を開始してください。</strong></> : activeCart.length === 0 ? <><span className="selection-kicker">次にすること</span><span>{EMPTY_DETAIL_MESSAGE}</span></> : lastAddedEntry ? <><span className="selection-kicker">追加した商品</span><strong>{lastAddedEntry.product.name}</strong><div className="selected-line-summary"><span>{lastAddedQuantity}点 × {lastAddedEntry.product.priceInclTax.toLocaleString()}円</span><strong>{lastAddedAmount.toLocaleString()}円</strong></div>{isAgeRestricted(lastAddedEntry.product) && <span className="age-check-note">年齢確認 {ageRequirement(lastAddedEntry.product)}歳以上</span>}</> : <><span className="selection-kicker">次にすること</span><span>{panel === "products" ? "商品を選択して登録してください。" : "明細を選択すると、数量変更・値引き・取消ができます。"}</span></>}{checkoutLocked && <div className={`print-status ${formatPrintStatus(printJob).className}`}><span>印刷</span><strong>{formatPrintStatus(printJob).label}</strong>{currentPublicReference && <small>受付 {currentPublicReference}</small>}</div>}</div><div className={`checkout-summary ${paymentSummaryVisible ? "payment-visible" : "before-payment"}`}><div className="checkout-values"><div className="checkout-total-row"><span className="checkout-label">合計</span><div className="checkout-total-main"><strong>{total.toLocaleString()}円</strong><small>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</small></div></div>{paymentSummaryVisible ? <><div className="checkout-payment-row"><span>お預り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? completedPaymentLabel : `${received.toLocaleString()}円`}</strong></div><div className="checkout-payment-row"><span>お釣り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? "—" : `${Math.max(0, received - total).toLocaleString()}円`}</strong></div></> : <div className="checkout-discount-row"><span>値引き額</span><strong>-{totalDiscountYen.toLocaleString()}円</strong></div>}</div>{checkoutLocked ? <button className="subtotal-large next-sale" onClick={clearFinishedTransaction}>次の取引</button> : <button className="subtotal-large" disabled={activeCart.length === 0 || !serverOnline} onClick={() => { setCancelFeedback(null); updateInputBuffer(""); setShowPayment(true); speakSubtotal(routedSpeech, `合計金額は ${formatJapaneseYenSpeech(total)}`); }}>小計</button>}</div></section>
    {inputAmount !== null && !showPayment && <div className="cash-popup"><span>お預り金額</span><strong>{inputAmount.toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showPayment && <div className="modal-backdrop payment-layer"><section className="payment-entry subtotal-payment-modal"><header><span>小計・支払方法</span><strong>{total.toLocaleString()}円</strong></header><div className="payment-entry-body"><div className="payment-methods"><button className="external-payment" onPointerUp={() => setPendingPaymentMethod("クレジット")}>クレジット</button><button className="external-payment" onPointerUp={() => setPendingPaymentMethod("売掛")}>売掛</button><button className="external-payment" onPointerUp={() => setPendingPaymentMethod("無配")}>無配</button><button className="payment-back" onPointerUp={() => { setShowPayment(false); updateInputBuffer(""); }}>戻る</button></div><div className="payment-keypad"><div className="payment-amount"><span>お預り金額</span><strong>{inputAmount !== null ? inputAmount.toLocaleString() : "0"}円</strong></div><button className="key-clear" onPointerUp={() => updateInputBuffer("")}>C</button>{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onPointerUp={() => updateInputBuffer((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 9))}>{key}</button>)}<button className="ten-thousand" onPointerUp={() => updateInputBuffer(convertToTenThousands)}>万</button><button className="exact-cash" onPointerUp={() => finishPayment("現金", total)}>ちょうど現計</button><button className="cash-complete" onPointerUp={() => finishPayment("現金")}>預・現計</button></div></div></section></div>}
    {pendingPaymentMethod && <div className="modal-backdrop error-layer"><div className="error-modal payment-confirm"><h2>支払方法の確認</h2><p>「{pendingPaymentMethod}」で会計を確定しますか？</p><button onPointerUp={() => { const method = pendingPaymentMethod; setPendingPaymentMethod(null); finishPayment(method); }}>確定</button><button onPointerUp={() => setPendingPaymentMethod(null)}>戻る</button></div></div>}
    {staffPermissions.has("catalog_import") && <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void file.text().then(importJson).catch(() => showSystemError("JSONファイルを読み込めませんでした。")); }} />}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><section className="business-menu-group"><h3>営業・現金</h3><button className="cash-management-button" onClick={() => { setShowBusinessMenu(false); setShowCashOperations(true); }}>現金管理・開局／点検／精算</button></section><section className="business-menu-group"><h3>販売の記録</h3><button onClick={() => { setShowBusinessMenu(false); setShowJournal(true); }}>ジャーナル参照</button><button onClick={() => { setShowBusinessMenu(false); setShowHoldOperations(true); }}>取り置き・受取会計</button>{staffPermissions.has("refund") && <button onClick={() => { setShowBusinessMenu(false); setShowReturnOperations(true); }}>全部返品</button>}</section>{(authActor?.role === "manager" || authActor?.role === "admin") && <section className="business-menu-group"><h3>在庫</h3><button onClick={() => { setShowBusinessMenu(false); setShowStockAdjustment(true); }}>在庫調整</button></section>}<section className="business-menu-group"><h3>状態確認</h3><button onClick={() => { setShowBusinessMenu(false); setShowOperationsDashboard(true); }}>運用ダッシュボード</button></section><section className="business-menu-group"><h3>設定</h3><label>音声話者<select value={audioSettings.speakerId} onChange={(event) => updateAudioSetting("speakerId", Number(event.target.value))}><option value="3">ずんだもん</option><option value="2">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label><div className="audio-volume-settings">{([['tapVolume','タップ音'],['errorVolume','操作エラー音'],['systemErrorVolume','システムエラー音'],['speechVolume','音声読み上げ']] as const).map(([key,label]) => <label key={key}><span>{label}</span><input aria-label={`${label}の音量`} type="range" min="0" max="100" value={audioSettings[key]} onChange={(event) => updateAudioSetting(key, Number(event.target.value))} /><output>{audioSettings[key]}</output><button type="button" onClick={() => { if (key === 'tapVolume') playOperationSound('tap', audioSettings.tapVolume); else if (key === 'errorVolume') playOperationSound('error', audioSettings.errorVolume); else if (key === 'systemErrorVolume') previewSystemErrorSound(audioSettings.systemErrorVolume); else routedSpeech.speak('合計金額は ひゃく えん です'); }}>試聴</button></label>)}</div>{([['showNumber','在庫残数を数字で表示'],['showSymbol','在庫残数を記号で表示'],['colorize','在庫残数で色を変える']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={stockDisplaySettings[key]} onChange={(event) => updateStockDisplaySetting(key, event.target.checked)} />{label}</label>)}{staffPermissions.has("catalog_import") && <button onClick={() => fileRef.current?.click()}>商品JSONインポート</button>}</section><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {showCashOperations && <CashOperations eventId={catalog.eventId} businessSessionId={businessSession.businessSessionId} businessDate={businessSession.businessDate} cashboxId={registerId} actorId={signedInResponsibleNumber} terminalId={registerId} onClose={() => { setShowCashOperations(false); void refreshLifecycle(); }} onArtifact={(artifact) => setBackupArtifacts((current) => [artifact, ...current.filter((item) => item.artifactId !== artifact.artifactId)])} />}
    {showJournal && <Journal eventId={catalog.eventId} initialDate={journalDate ?? businessSession?.businessDate ?? localBusinessDate()} initialReference={journalReference} onClose={() => { setShowJournal(false); setJournalReference(""); setJournalDate(null); }} onReprint={openJournalReprint} onReceipt={openJournalReceipt} onReturn={openJournalReturn} />}
    {showOperationsDashboard && <OperationsDashboard eventId={catalog.eventId} businessDate={localBusinessDate()} actorId={signedInResponsibleNumber} onClose={() => setShowOperationsDashboard(false)} backupArtifacts={backupArtifacts} backupArtifactsLoading={backupArtifactsLoading} backupArtifactsError={backupArtifactsError} onRegenerateBackupArtifact={regenerateBackupArtifact} />}
    {showReturnOperations && <ReturnOperations eventId={catalog.eventId} businessDate={localBusinessDate()} cashboxId={registerId} actorId={signedInResponsibleNumber} terminalId={registerId} onClose={() => setShowReturnOperations(false)} initialQuery={returnReference} />}
    {showHoldOperations && <HoldOperations eventId={catalog.eventId} registerId={registerId} terminalId={terminalId} draft={serverDraft} isManager={authActor?.role === "manager" || authActor?.role === "admin"} onDraft={applyDraft} onClose={() => { setShowHoldOperations(false); setHoldSearchReference(""); }} initialReference={holdSearchReference} />}
    {showStockAdjustment && <StockAdjustment eventId={catalog.eventId} products={catalog.products} onClose={() => setShowStockAdjustment(false)} />}
    {showReprint && <div className="modal-backdrop reprint-layer"><section className="reprint-modal"><h2>再印刷の確認</h2><p>元受付番号 <strong>{currentPublicReference}</strong></p><label>実物結果<select value={reprintOutcome} onChange={(event) => setReprintOutcome(event.target.value as typeof reprintOutcome)}><option value="not_printed">印字されていない</option><option value="printed">印字済み</option><option value="indeterminate">結果不明</option></select></label><label>理由<ReasonSelect value={reprintReason} onChange={setReprintReason} /></label><label className="reprint-check"><input type="checkbox" checked={reprintRiskAccepted} onChange={(event) => setReprintRiskAccepted(event.target.checked)} />二重印刷リスクを承認する</label><label className="reprint-check"><input type="checkbox" checked={reprintManagerApproved} onChange={(event) => setReprintManagerApproved(event.target.checked)} />責任者 {signedInResponsibleNumber} として承認する（自己承認を監査）</label><p className="reprint-warning">印字済み・結果不明では、両方の承認が必須です。元jobは再送せず、新しい再印刷jobを作成します。</p><div><button onClick={submitReprint}>再印刷jobを作成</button><button onClick={() => setShowReprint(false)}>戻る</button></div></section></div>}
    {quantityEditLine && <div className="modal-backdrop quantity-layer"><section className="quantity-modal" aria-label="数量変更"><header><span>{quantityEditLine.product.name}</span><strong>現在の数量 {quantityEditLine.quantity}点</strong></header><div className="quantity-display"><span>入力中の数量</span><strong>{quantityInput || "0"}点</strong></div><div className="quantity-keypad">{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0"].map((key) => <button key={key} onClick={() => setQuantityInput((current) => `${current}${key}`.replace(/^0+(?=\d)/, ""))}>{key}</button>)}<button className="quantity-clear" onClick={() => setQuantityInput("")}>C</button><button className="quantity-back" onClick={() => setQuantityInput((current) => current.slice(0, -1))}>1桁削除</button><button className="quantity-apply" onClick={() => { const quantity = Number(quantityInput); if (quantityEditLine.lineId && Number.isSafeInteger(quantity) && quantity > 0) { const line = quantityEditLine; setQuantityEditLine(null); if (lastAddedShortcut?.lineId === line.lineId) setLastAddedShortcut({ lineId: line.lineId!, eligible: false }); void runDraftMutation((draft) => checkoutApi.updateLine(draft.draftId, line.lineId!, draft.version, { quantity })).then((next) => { if (next) highlightLine(line.product.productCode, line.cancelled ? "cancelled" : "active", line.cancelled ? "cancel" : "quantity"); }); } }}>確定</button></div></section></div>}
    {selectedLineItem && selectedLine !== null && showPriceChange && <div className="modal-backdrop price-change-layer"><section className="price-change-modal"><header><span>{selectedLineItem.product.name}</span><strong>現在単価 {selectedLineItem.product.priceInclTax.toLocaleString()}円</strong></header>{discountMode === null ? <div className="discount-mode-selector"><p>値引き方法を選択してください</p><button onClick={() => { setDiscountMode("percent"); setDiscountInput(""); }}>％引き</button><button onClick={() => { setDiscountMode("amount"); setDiscountInput(""); }}>金額値引き</button><button className="price-change-back" onClick={closePriceChange}>戻る</button></div> : <div className="discount-entry"><div className="discount-display"><span>{discountMode === "percent" ? "値引率" : "値引額"}</span><strong>{discountInput ? Number(discountInput).toLocaleString() : "0"}{discountMode === "percent" ? "％" : "円"}</strong><small>変更後単価　{priceChangePreview === null ? "—" : `${priceChangePreview.toLocaleString()}円`}</small></div><div className="discount-keypad">{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onClick={() => setDiscountInput((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 7))}>{key}</button>)}<button className="discount-clear" onClick={() => setDiscountInput("")}>C</button><button className="discount-back" onClick={() => { setDiscountMode(null); setDiscountInput(""); }}>戻る</button><button className="discount-apply" disabled={priceChangePreview === null} onClick={applySelectedDiscount}>確定</button></div></div>}</section></div>}
    {pendingUnknownProduct && <div className="modal-backdrop unknown-product-layer"><form className="modal unknown-product-modal" onSubmit={(event) => { event.preventDefault(); submitUnknownProduct(); }}><h2 id="unknown-product-title">未登録商品の価格入力</h2><p>JAN {pendingUnknownProduct.code} は商品マスタにありません。今回の会計だけ仮登録します。</p><label>税込価格<input autoFocus inputMode="numeric" value={pendingUnknownProduct.priceInput} onChange={(event) => setPendingUnknownProduct((current) => current ? { ...current, priceInput: event.target.value.replace(/\D/g, "").slice(0, 9) } : current)} /></label><label>税率<select value={pendingUnknownProduct.taxRate} onChange={(event) => setPendingUnknownProduct((current) => current ? { ...current, taxRate: Number(event.target.value) as 0 | 8 | 10 } : current)}><option value="10">10%</option><option value="8">8%</option><option value="0">0%（非課税）</option></select></label><button type="submit" disabled={pendingUnknownProduct.saving || !pendingUnknownProduct.priceInput}>{pendingUnknownProduct.saving ? "追加中…" : "仮登録して会計に追加"}</button><button type="button" onClick={() => setPendingUnknownProduct(null)}>読み取りを取り消す</button></form></div>}
    {showSignIn && <div className="modal-backdrop"><form className="modal sign-in" onSubmit={(event) => { event.preventDefault(); signIn(); }}><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者番号を入力後、【サインオン】をタッチまたは Enter</p><input aria-label="責任者番号" inputMode="numeric" maxLength={3} placeholder="責任者番号" value={responsibleNumber} onChange={(event) => setResponsibleNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /><button type="submit">サインオン</button></form></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div><AgeConfirmationActions state={ageFlowState} setState={setAgeFlowState} onConfirm={confirmAge} onReject={closeAgeConfirmation} /></div></div>}
    {errorModal && <ErrorDialog error={errorModal} onConfirm={() => { stopOperationSound(); setErrorModal(null); }} onStop={stopOperationSound} onCreateReport={(error) => { const mailto = createErrorReportMailto(error); if (mailto) window.location.href = mailto; }} />}
    {cancelConfirm && <div className="modal-backdrop error-layer"><section className="error-modal cancel-confirm"><h2>登録中止</h2><p>次の明細をすべて取り消して、登録を中止しますか？</p><div className="delete-line-list">{activeCart.map((line, index) => <div key={`${line.product.productCode}-${index}`}><span>No. {index + 1}</span><strong>{line.product.name}</strong><span>{line.quantity}点</span><strong>{(serverDraft?.calculation.lines.find((item) => item.lineId === line.lineId)?.netYen ?? line.product.priceInclTax * line.quantity).toLocaleString()}円</strong></div>)}</div><button ref={cancelConfirmButtonRef} className="danger-action" onClick={() => { cancelRegistration(); setCancelConfirm(false); }}>中止する</button><button className="secondary-action" onClick={() => setCancelConfirm(false)}>戻る</button></section></div>}
    {supplementalUi}
    {emergencyModal}
  </main>;
}

function Launcher() {
  const [registerNumber, setRegisterNumber] = useState(1);
  const training = isTrainingMode();
  const openRegister = (role: RegisterRole, mode?: "training") => { const url = new URL(window.location.href); if (mode === "training") { url.protocol = "http:"; url.port = "3002"; } url.search = new URLSearchParams({ register: String(registerNumber), role, ...(mode ? { mode } : {}) }).toString(); window.location.assign(url); };
  return <main className={training ? "launcher-screen training-mode" : "launcher-screen"}>{training && TRAINING_BANNER}<section className="launcher-card"><div className="launcher-mark">POS</div><h1>ぽすりん</h1><p>使用するレジ番号と画面を選択してください。</p><fieldset><legend>レジ番号</legend><div className="register-selector">{[1, 2, 3, 4].map((number) => <button key={number} className={registerNumber === number ? "active" : ""} onClick={() => setRegisterNumber(number)}>レジ{number}</button>)}</div></fieldset><div className="role-selector"><button className="staff-launch" onClick={() => openRegister("staff")}><strong>店員側画面</strong><span>商品登録・会計操作</span></button><button className="customer-launch" onClick={() => openRegister("customer")}><strong>顧客側画面</strong><span>明細・合計・年齢確認</span></button><button className="admin-launch" onClick={() => window.location.assign("/?role=admin")}><strong>管理画面</strong><span>マスタ・帳票・運用設定</span></button></div><button className="training-launch" onClick={() => openRegister("staff", "training")}><strong>トレーニングモード</strong><span>本番DBを変更せず、会計・印刷を練習</span></button><small>ホーム画面から起動した場合も、この画面で使用するレジを選択します。</small></section></main>;
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
  if (role === "admin") return <AdminSettings eventId={initialCatalog.eventId} />;
  if ((role !== "staff" && role !== "customer") || !Number.isInteger(registerNumber) || registerNumber < 1 || registerNumber > 4) return <Launcher />;
  return <App role={role} registerNumber={registerNumber} />;
}

if (import.meta.env.PROD && "serviceWorker" in navigator) window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js"); });

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
