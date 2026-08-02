import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateAutoDiscounts, exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, taxCategoryLabel, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, playOperationSound, speakAgeCheckRequired, speakChangeReady, speakEmergencyAlertReceived, speakIdentityMayBeRequested, speakProductPrice, speakReceiptReady, speakSubtotal, stopOperationSound, type SpeechPlayer } from "./speech.js";
import { demoCatalog } from "./demo-catalog.js";
import { normalizeResponsibleNumber } from "./responsible-number.js";
import { convertToTenThousands } from "./tender-input.js";
import "./styles.css";

const initialCatalog: EventCatalog = demoCatalog;

type RegisterRole = "staff" | "customer";
type EmergencyAlert = { id: string; title: string; message: string; receivedAt: string; source?: string };
type RegisterSnapshot = {
  cart: Array<{ productCode: string; quantity: number; priceInclTax?: number; cancelled?: boolean }>;
  checkout: { showPayment: boolean; inputBuffer: string; paymentFinished: boolean; received: number; completedPaymentLabel: string };
};

function App({ role, registerNumber }: { role: RegisterRole; registerNumber: number }) {
  const storageKey = (suffix: string) => `event-pos-register-${registerNumber}-${suffix}`;
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<Array<{ product: ProductDefinition; quantity: number; cancelled?: boolean }>>([]);
  const [responsibleNumber, setResponsibleNumber] = useState("");
  const [signedInResponsibleNumber, setSignedInResponsibleNumber] = useState("---");
  const [signedInUser, setSignedInUser] = useState("---");
  const [speakerId, setSpeakerId] = useState(() => Number(localStorage.getItem(storageKey("speaker")) ?? 3));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<{ name: string; quantity: number; unitPrice: number } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [productTab, setProductTab] = useState("all");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [showPriceChange, setShowPriceChange] = useState(false);
  const [discountMode, setDiscountMode] = useState<"percent" | "amount" | null>(null);
  const [discountInput, setDiscountInput] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [pendingPaymentMethod, setPendingPaymentMethod] = useState<"クレジット" | "売掛" | "無配" | null>(null);
  const [ageProduct, setAgeProduct] = useState<ProductDefinition | null>(null);
  const [ageCustomerSkipAvailable, setAgeCustomerSkipAvailable] = useState(false);
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
  const ageRequirement = (product: ProductDefinition): 18 | 20 | null => product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : product.ageCheck === "none" ? null : /R18|18禁|成人向け/.test(product.name) ? 18 : /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name) ? 20 : null;
  const isAgeRestricted = (product: ProductDefinition) => ageRequirement(product) !== null;
  const showError = (message: string) => { playOperationSound("error"); setErrorModal(message); };
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const highlightTimeoutRef = useRef<number | null>(null);
  const registerSyncChannelRef = useRef<BroadcastChannel | null>(null);
  const lastRegisterStateRef = useRef<string | null>(null);
  const lastEmergencyAlertIdRef = useRef<string | null>(null);
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
  const activeCart = cart.filter((line) => !line.cancelled);
  const staffPermissions = new Set(catalog.staffMembers?.find((member) => member.responsibleNumber === signedInResponsibleNumber)?.permissions ?? []);
  const canCancelRegistration = activeCart.length > 0;
  const autoDiscounts = calculateAutoDiscounts(activeCart.reduce((quantities, line) => quantities.set(line.product.productCode, (quantities.get(line.product.productCode) ?? 0) + line.quantity), new Map<string, number>()), catalog.autoDiscountRules ?? []);
  const autoDiscountYen = autoDiscounts.reduce((sum, discount) => sum + discount.discountYen, 0);
  const customerRequiresAge = activeCart.some((line) => isAgeRestricted(line.product)) && customerAgeNotice !== "verified" && !customerAgeAcknowledged;
  const visibleProducts = catalog.products.filter((product) => productTab === "all" || product.tabId === productTab);
  const total = activeCart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0) - autoDiscountYen;
  const clearFinishedTransaction = () => { setCart([]); setLastAdded(null); setPaymentFinished(false); setCompletedPaymentLabel("現金"); setReceived(0); setInputBuffer(""); setAgeVerified(false); setAgeVerifiedMinimum(0); setAgeFlowState("idle"); localStorage.removeItem(storageKey("age-check")); };
  const finishPayment = (method: "現金" | "クレジット" | "売掛" | "無配", tenderedAmount?: number) => {
    if (paymentFinished) return showError("この取引は会計済みです。次の取引を開始してください。");
    if (activeCart.length === 0) return showError("商品が登録されていません。先に商品を登録してください。");
    const amount = method === "現金" ? tenderedAmount ?? Number(inputBuffer) : 0;
    if (method === "現金" && (tenderedAmount === undefined && !inputBuffer || !Number.isSafeInteger(amount) || amount < total)) return showError("預り金が不足しています。合計金額以上を入力してください。");
    if (method === "現金" && amount - total >= 10000) return showError("お釣りが10,000円以上になる預り金は入力できません。");
    setReceived(amount); setCompletedPaymentLabel(method); setPaymentFinished(true); setShowPayment(false); setInputBuffer(""); playOperationSound("complete");
    if (method === "現金" && amount > total) speakChangeReady(speech); else speakReceiptReady(speech);
  };
  useEffect(() => {
    const applySnapshot = (snapshot: RegisterSnapshot | null, legacyCart: RegisterSnapshot["cart"] = []) => { const saved = snapshot?.cart ?? legacyCart; setCart(saved.flatMap((item) => { const catalogProduct = catalog.products.find((candidate) => candidate.productCode === item.productCode); if (!catalogProduct) return []; const product = item.priceInclTax === undefined ? catalogProduct : { ...catalogProduct, priceInclTax: item.priceInclTax }; return [{ product, quantity: item.quantity, ...(item.cancelled ? { cancelled: true } : {}) }]; })); if (role === "customer" && snapshot?.checkout) { setShowPayment(snapshot.checkout.showPayment); setInputBuffer(snapshot.checkout.inputBuffer); setPaymentFinished(snapshot.checkout.paymentFinished); setReceived(snapshot.checkout.received); setCompletedPaymentLabel(snapshot.checkout.completedPaymentLabel); } };
    const sync = (event?: StorageEvent) => { if (event?.key && event.key !== storageKey("register-state") && event.key !== storageKey("cart")) return; try { const raw = localStorage.getItem(storageKey("register-state")); if (raw && raw === lastRegisterStateRef.current) return; const legacyCart = JSON.parse(localStorage.getItem(storageKey("cart")) ?? "[]") as RegisterSnapshot["cart"]; const snapshot = JSON.parse(raw ?? "null") as RegisterSnapshot | null; lastRegisterStateRef.current = raw; applySnapshot(snapshot, legacyCart); } catch { /* ignore malformed preview state */ } };
    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(`event-pos-register-${registerNumber}`);
    registerSyncChannelRef.current = channel;
    if (role === "customer" && channel) channel.onmessage = (event: MessageEvent<RegisterSnapshot>) => { lastRegisterStateRef.current = JSON.stringify(event.data); applySnapshot(event.data); };
    sync(); window.addEventListener("storage", sync);
    const recoveryTimer = role === "customer" ? window.setInterval(() => sync(), 250) : null;
    return () => { window.removeEventListener("storage", sync); if (recoveryTimer !== null) window.clearInterval(recoveryTimer); channel?.close(); if (registerSyncChannelRef.current === channel) registerSyncChannelRef.current = null; };
  }, [catalog.products, role]);
  useEffect(() => { if (role !== "staff") return; const savedCart = cart.map((line) => ({ productCode: line.product.productCode, quantity: line.quantity, priceInclTax: line.product.priceInclTax, ...(line.cancelled ? { cancelled: true } : {}) })); const snapshot: RegisterSnapshot = { cart: savedCart, checkout: { showPayment, inputBuffer, paymentFinished, received, completedPaymentLabel } }; localStorage.setItem(storageKey("register-state"), JSON.stringify(snapshot)); localStorage.setItem(storageKey("cart"), JSON.stringify(savedCart)); registerSyncChannelRef.current?.postMessage(snapshot); }, [cart, role, showPayment, inputBuffer, paymentFinished, received, completedPaymentLabel]);
  useEffect(() => { if (role !== "customer") return; const syncAge = () => { const value = localStorage.getItem(storageKey("age-check")); setCustomerAgeNotice(value?.startsWith("verified") ? "verified" : value?.startsWith("required") ? "required" : null); setCustomerAgeMinimum(value?.endsWith(":18") ? 18 : 20); }; syncAge(); window.addEventListener("storage", syncAge); return () => window.removeEventListener("storage", syncAge); }, [role]);
  useEffect(() => { if (role !== "customer") return; const syncHighlight = (event: StorageEvent) => { if (event.key !== storageKey("line-highlight") || !event.newValue) return; try { const value = JSON.parse(event.newValue) as { highlightKey?: string; productCode?: string }; const highlightKey = value.highlightKey ?? (value.productCode ? `active:${value.productCode}` : null); if (!highlightKey) return; triggerHighlight(highlightKey); } catch { /* ignore malformed preview state */ } }; window.addEventListener("storage", syncHighlight); return () => window.removeEventListener("storage", syncHighlight); }, [role]);
  useEffect(() => () => { if (highlightTimeoutRef.current !== null) window.clearTimeout(highlightTimeoutRef.current); }, []);
  useEffect(() => {
    if (!highlighted) return;
    const row = document.querySelector<HTMLElement>(".line-highlight");
    row?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [highlighted, cart, panel]);
  useEffect(() => { if (role !== "staff" || !ageProduct || ageFlowState !== "customer_pending") return; const onCustomerAge = () => { if (localStorage.getItem(storageKey("age-response")) === "yes") { localStorage.removeItem(storageKey("age-response")); setAgeFlowState("staff_pending"); } }; window.addEventListener("storage", onCustomerAge); onCustomerAge(); return () => window.removeEventListener("storage", onCustomerAge); }, [role, ageProduct, ageFlowState]);
  useEffect(() => {
    if (role !== "staff") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (showSignIn || selectedLine !== null || isFormInput) return;
      if (paymentFinished && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt" && event.key !== "Meta") { event.preventDefault(); clearFinishedTransaction(); return; }
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setInputBuffer((value) => value + event.key); return; }
      if (event.key === "Escape") { setInputBuffer(""); return; }
      if (event.key === "Enter" && inputBuffer) {
        event.preventDefault();
        if (total === 0) { const product = inputBuffer.length >= 8 ? catalog.products.find((candidate) => candidate.productCode === inputBuffer) : undefined; setInputBuffer(""); if (product) addProduct(product); else showError(inputBuffer.length >= 8 ? "商品コードが見つかりません。登録済みコードを入力してください。" : "会計待ちです。商品を登録してから預り金を入力してください。"); return; }
        finishPayment("現金");
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputBuffer, paymentFinished, role, selectedLine, showSignIn, speech, total, catalog.products]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then(setCatalog).catch(() => { showError("カタログを読み込めません。初期値を表示しています"); }); }, []);
  useEffect(() => { let stopped = false; const poll = () => { void fetch("/api/v1/emergency-alerts/latest", { cache: "no-store" }).then(async (response) => response.ok ? await response.json() as { alert: EmergencyAlert | null } : null).then((result) => { const alert = result?.alert; if (stopped || !alert || alert.id === lastEmergencyAlertIdRef.current) return; lastEmergencyAlertIdRef.current = alert.id; setEmergencyAlert(alert); speakEmergencyAlertReceived(speech); }).catch(() => { /* 次回のポーリングで復旧する */ }); }; poll(); const timer = window.setInterval(poll, 1000); return () => { stopped = true; window.clearInterval(timer); }; }, [speech]);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const highlightLine = (productCode: string, state: "active" | "cancelled" = "active") => { const highlightKey = `${state}:${productCode}`; triggerHighlight(highlightKey); localStorage.setItem(storageKey("line-highlight"), JSON.stringify({ highlightKey, productCode, at: Date.now() })); };
  const addProduct = (product: ProductDefinition, quantity = 1, announce = true, ageCheckBypass = false) => {
    if (product.saleState !== "on_sale") return showError("この商品は販売停止中のため登録できません。");
    if (paymentFinished) clearFinishedTransaction();
    const requiredAge = ageRequirement(product);
    if (!ageCheckBypass && requiredAge && (paymentFinished || !ageVerified || ageVerifiedMinimum < requiredAge)) { localStorage.setItem(storageKey("age-check"), `required:${requiredAge}`); setAgeCustomerSkipAvailable(true); setAgeFlowState("customer_pending"); speakAgeCheckRequired(speech); return setAgeProduct(product); }
    setLastAdded({ name: product.name, quantity, unitPrice: product.priceInclTax });
    playOperationSound("register");
    highlightLine(product.productCode);
    setCart((current) => {
      const existing = current.findIndex((line) => !line.cancelled && line.product.productCode === product.productCode);
      if (existing < 0) return [...current, { product, quantity }];
      return current.map((line, index) => index === existing ? { ...line, quantity: line.quantity + quantity } : line);
    });
    if (announce) speakProductPrice(speech, formatJapaneseYenSpeech(product.priceInclTax));
  };
  const addQuick = (quick: QuickEntry) => {
    const components = quick.productCode ? [{ productCode: quick.productCode, quantity: quick.quantity ?? 1 }] : (quick.components ?? []);
    let addedTotal = 0;
    for (const component of components) { const p = catalog.products.find((item) => item.productCode === component.productCode); if (p) { if (isAgeRestricted(p) && !ageVerified) { addProduct(p, component.quantity, false); return; } addedTotal += p.priceInclTax * component.quantity; addProduct(p, component.quantity, false); } }
    if (addedTotal > 0) speakProductPrice(speech, formatJapaneseYenSpeech(addedTotal));
  };
  const changeQuantity = (productCode: string, delta: number) => { setCart((current) => current.flatMap((line) => line.product.productCode === productCode ? (line.quantity + delta > 0 ? [{ ...line, quantity: line.quantity + delta }] : []) : [line])); highlightLine(productCode); };
  const setQuantity = (lineIndex: number) => { const line = cart[lineIndex]; if (!line) return; const value = window.prompt("数量を入力", String(line.quantity)); const quantity = Number(value); if (Number.isSafeInteger(quantity) && quantity > 0) { setCart((current) => current.map((item, index) => index === lineIndex ? { ...item, quantity } : item)); highlightLine(line.product.productCode, line.cancelled ? "cancelled" : "active"); } };
  const cancelRegistration = () => { setCart([]); setLastAdded(null); setReceived(0); setPaymentFinished(false); setAgeVerified(false); setAgeProduct(null); localStorage.removeItem(storageKey("age-check")); };
  const selectedLineItem = selectedLine !== null ? cart[selectedLine] : undefined;
  const priceChangePreview = (() => { if (!selectedLineItem || !discountMode || !discountInput) return null; const value = Number(discountInput); if (!Number.isSafeInteger(value) || value < 0) return null; return discountMode === "percent" ? (value <= 100 ? Math.floor(selectedLineItem.product.priceInclTax * (100 - value) / 100) : null) : (value <= selectedLineItem.product.priceInclTax ? selectedLineItem.product.priceInclTax - value : null); })();
  const closePriceChange = () => { setShowPriceChange(false); setDiscountMode(null); setDiscountInput(""); };
  const applySelectedDiscount = () => { if (!selectedLineItem || selectedLine === null || priceChangePreview === null) return showError(discountMode === "percent" ? "値引率は0～100％で入力してください。" : "値引額は現在の単価以下で入力してください。"); setCart((current) => current.map((line, index) => index === selectedLine ? { ...line, product: { ...line.product, priceInclTax: priceChangePreview } } : line)); highlightLine(selectedLineItem.product.productCode, selectedLineItem.cancelled ? "cancelled" : "active"); closePriceChange(); setSelectedLine(null); };
  useEffect(() => { if (!showPriceChange) return; const onDiscountKey = (event: KeyboardEvent) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setDiscountInput((current) => `${current}${event.key}`.replace(/^0+(?=\d)/, "").slice(0, 7)); } else if (event.key === "Backspace") { event.preventDefault(); setDiscountInput((current) => current.slice(0, -1)); } else if (event.key === "Escape") { event.preventDefault(); closePriceChange(); } else if (event.key === "Enter" && discountMode) { event.preventDefault(); applySelectedDiscount(); } }; window.addEventListener("keydown", onDiscountKey); return () => window.removeEventListener("keydown", onDiscountKey); }, [showPriceChange, discountMode, discountInput, priceChangePreview, selectedLine]);
  const confirmAge = () => { const verifiedMinimum = ageProduct ? (ageRequirement(ageProduct) ?? 20) : 20; setAgeVerified(true); setAgeVerifiedMinimum(verifiedMinimum); setAgeCustomerSkipAvailable(false); setAgeFlowState("idle"); localStorage.setItem(storageKey("age-check"), `verified:${verifiedMinimum}`); if (ageProduct) { const product = ageProduct; setAgeProduct(null); addProduct(product, 1, true, true); } };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).then(() => { setCart([]); }).catch((error) => showError(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { showError(error instanceof Error ? error.message : "JSONが不正です"); } };
  const customerCheckoutStatus = paymentFinished ? (completedPaymentLabel === "現金" ? `お預り ${received.toLocaleString()}円　お釣り ${Math.max(0, received - total).toLocaleString()}円` : `支払方法 ${completedPaymentLabel}　会計済み`) : showPayment ? (inputBuffer ? `お預り入力 ${Number(inputBuffer).toLocaleString()}円` : "お支払いをお願いします") : null;
  const isLineHighlighted = (line: { product: ProductDefinition; cancelled?: boolean }) => highlighted === `${line.cancelled ? "cancelled" : "active"}:${line.product.productCode}`;
  const emergencyModal = emergencyAlert && <div className="modal-backdrop emergency-layer"><section className="emergency-modal" role="alertdialog" aria-modal="true"><h2>緊急情報</h2><h3>{emergencyAlert.title}</h3><p>{emergencyAlert.message}</p><small>受信時刻 {new Date(emergencyAlert.receivedAt).toLocaleString("ja-JP")}</small><button onClick={() => setEmergencyAlert(null)}>確認</button></section></div>;
  if (role === "customer") return <main className="pos-screen customer-screen"><section className="customer-lines">{(customerAgeNotice || customerRequiresAge) && <div className={`age-notice ${customerAgeNotice === "verified" ? "" : "customer-age-prompt"} ${customerAgeNotice ?? "required"}`}><strong>{customerAgeNotice === "verified" ? `年齢確認済み（${customerAgeMinimum}歳以上）` : `あなたは${customerAgeMinimum}歳以上ですか？`}</strong>{customerAgeNotice !== "verified" && <button className="customer-age-yes" onPointerUp={() => { localStorage.setItem(storageKey("age-response"), "yes"); localStorage.setItem(storageKey("age-check"), "verified"); setCustomerAgeAcknowledged(true); setCustomerAgeNotice(null); speakIdentityMayBeRequested(speech); }}>はい</button>}</div>}{cart.length === 0 ? <div className="customer-empty customer-welcome">{catalog.customerWelcome?.imageUrl && <img src={catalog.customerWelcome.imageUrl} alt="" />}{catalog.customerWelcome?.circleName && <strong>{catalog.customerWelcome.circleName}</strong>}{catalog.customerWelcome?.space && <span>{catalog.customerWelcome.space}</span>}<p>{catalog.customerWelcome?.message ?? "いらっしゃいませ"}</p></div> : <><div className="customer-line customer-line-head"><span>商品名</span><span>単価</span><span>点数</span></div>{cart.map((line, index) => <div data-product-code={line.product.productCode} className={`customer-line ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>@{line.product.priceInclTax.toLocaleString()}</span><span>{line.quantity}点</span></div>)}</>}{autoDiscounts.map((discount) => <div className="customer-discount" key={discount.ruleId}><span>{discount.label}{discount.applications > 1 ? ` ×${discount.applications}` : ""}</span><strong>-{discount.discountYen.toLocaleString()}円</strong></div>)}</section><footer className="customer-total"><span>{customerCheckoutStatus ?? `合計 ${activeCart.reduce((sum, line) => sum + line.quantity, 0)}点`}</span><strong>{total.toLocaleString()}円</strong></footer>{emergencyModal}</main>;
  return <main className="pos-screen register-shell">
    <header className="register-header"><div className="header-actions"><button className="business-menu-button" onClick={() => setShowBusinessMenu(true)}>業務メニュー</button><button className="cancel-top" disabled={!canCancelRegistration} onClick={() => { if (canCancelRegistration) setCancelConfirm(true); }}>登録中止</button></div><p className="operation-guide">商品を登録してください。<br />登録が終わったら、小計を押して支払方法と預り金額を入力します。</p><p className="signed-in-user"><span>レジ{registerNumber}　{signedInUser}</span><span>責任者番号 {signedInResponsibleNumber}</span></p></header>
    {panel === "products" ? <section className="product-panel"><aside className="mini-cart"><button className="panel-switch" onClick={() => setPanel("detail")}>登録明細へ</button><div className="mini-cart-head"><span>商品名</span><span>数量</span><span>単価</span></div><div className="mini-cart-lines">{cart.length === 0 ? <div className="mini-cart-empty">登録待ち</div> : cart.map((line, index) => <div role="button" tabIndex={0} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`mini-cart-line ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span></div>)}</div><footer><span>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></aside><div className="product-picker"><div className="product-tabs"><button className={productTab === "all" ? "active" : ""} onClick={() => setProductTab("all")}>すべて</button>{(catalog.productTabs ?? []).map((tab) => <button key={tab.id} className={productTab === tab.id ? "active" : ""} style={tab.color ? { backgroundColor: tab.color } : undefined} onClick={() => setProductTab(tab.id)}>{tab.label}</button>)}</div><div className="product-grid">{visibleProducts.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} style={product.displayColor ? { backgroundColor: product.displayColor } : undefined} onClick={() => addProduct(product)}>{product.thumbnailUrl && <img className="product-thumbnail" src={product.thumbnailUrl} alt="" />}<strong>{product.name}</strong></button>)}{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><strong>{quick.label}</strong></button>)}</div></div></section> : <section className="detail-panel"><button className="panel-switch" onClick={() => setPanel("products")}>商品登録へ</button><div className="detail-head"><span>NO.</span><span>税区分</span><span>商品名</span><span>数量</span><span>単価</span><span>値引</span><span>操作</span></div>{cart.map((line, index) => <div role="button" tabIndex={0} onClick={() => setSelectedLine(index)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(index); }} className={`detail-row ${line.cancelled ? "cancelled-line" : ""} ${isLineHighlighted(line) ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>{taxCategoryLabel(line.product.taxCategory)}</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>—</span><span>タップして操作</span></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="staff-bottom"><div className="last-added">{autoDiscounts.map((discount) => <div className="auto-discount" key={discount.ruleId}>{discount.label}{discount.applications > 1 ? ` ×${discount.applications}` : ""}　-{discount.discountYen.toLocaleString()}円</div>)}{lastAdded ? <><strong>{lastAdded.name}</strong><span>{lastAdded.quantity}個　{lastAdded.unitPrice.toLocaleString()}</span></> : <span>登録待ち</span>}</div><div className="checkout-summary"><div className="checkout-values"><div><span>合計</span><strong>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点　{total.toLocaleString()}円</strong></div><div><span>お預り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? completedPaymentLabel : `${received.toLocaleString()}円`}</strong></div><div><span>お釣り</span><strong>{paymentFinished && completedPaymentLabel !== "現金" ? "—" : `${Math.max(0, received - total).toLocaleString()}円`}</strong></div></div><button className="subtotal-large" disabled={paymentFinished} onClick={() => { if (activeCart.length === 0) return showError("商品が登録されていません。先に商品を登録してください。"); setInputBuffer(""); setShowPayment(true); speakSubtotal(speech, `合計金額は ${formatJapaneseYenSpeech(total)}`); }}>{paymentFinished ? "会計済" : "小計"}</button></div></section>
    {inputBuffer && !showPayment && <div className="cash-popup"><span>お預り金額</span><strong>{Number(inputBuffer).toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showPayment && <div className="modal-backdrop payment-layer"><section className="payment-entry"><header><span>合計</span><strong>{total.toLocaleString()}円</strong></header><div className="payment-entry-body"><div className="payment-methods"><button onPointerUp={() => setPendingPaymentMethod("クレジット")}>クレジット</button><button onPointerUp={() => setPendingPaymentMethod("売掛")}>売掛</button><button onPointerUp={() => setPendingPaymentMethod("無配")}>無配</button><button className="payment-back" onPointerUp={() => { setShowPayment(false); setInputBuffer(""); }}>戻る</button></div><div className="payment-keypad"><div className="payment-amount"><span>お預り金額</span><strong>{inputBuffer ? Number(inputBuffer).toLocaleString() : "0"}円</strong></div><button className="exact-cash" onPointerUp={() => finishPayment("現金", total)}>ちょうど現計</button><button className="key-clear" onPointerUp={() => setInputBuffer("")}>C</button>{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onPointerUp={() => setInputBuffer((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 9))}>{key}</button>)}<button className="ten-thousand" onPointerUp={() => setInputBuffer(convertToTenThousands)}>万</button><button className="cash-complete" onPointerUp={() => finishPayment("現金")}>預・現計</button></div></div></section></div>}
    {pendingPaymentMethod && <div className="modal-backdrop error-layer"><div className="error-modal payment-confirm"><h2>支払方法の確認</h2><p>「{pendingPaymentMethod}」で会計を確定しますか？</p><button onPointerUp={() => { const method = pendingPaymentMethod; setPendingPaymentMethod(null); finishPayment(method); }}>確定</button><button onPointerUp={() => setPendingPaymentMethod(null)}>戻る</button></div></div>}
    {staffPermissions.has("catalog_import") && <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void file.text().then(importJson).catch(() => showError("JSONファイルを読み込めませんでした。")); }} />}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><label>音声話者<select value={speakerId} onChange={(event) => { const next = Number(event.target.value); setSpeakerId(next); localStorage.setItem(storageKey("speaker"), String(next)); speech.setSpeaker(next); }}><option value="3">ずんだもん</option><option value="2">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label>{staffPermissions.has("catalog_import") && <button onClick={() => fileRef.current?.click()}>商品JSONインポート</button>}{staffPermissions.has("refund") && <button onClick={() => showError("返金機能は準備中です。")}>返金</button>}{staffPermissions.has("reprint") && <button onClick={() => showError("再印刷機能は準備中です。")}>再印刷</button>}<button onClick={() => { if (activeCart.length > 0) return showError("登録中の商品があるため責任者を解除できません。登録を完了または中止してください。"); setShowBusinessMenu(false); setResponsibleNumber(""); setSignedInResponsibleNumber("---"); setSignedInUser("---"); setShowSignIn(true); }}>責任者解除</button><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {selectedLineItem && selectedLine !== null && !showPriceChange && <div className="modal-backdrop"><div className="line-menu"><h2>{selectedLineItem.product.name}</h2><button onClick={() => { setCart((current) => current.map((line, index) => index === selectedLine ? { ...line, cancelled: true } : line)); playOperationSound("cancel"); highlightLine(selectedLineItem.product.productCode, "cancelled"); setSelectedLine(null); }}>取り消し</button><button onClick={() => { setQuantity(selectedLine); setSelectedLine(null); }}>数量変更</button><button onClick={() => setShowPriceChange(true)}>売価変更</button><button onClick={() => setSelectedLine(null)}>閉じる</button></div></div>}
    {selectedLineItem && selectedLine !== null && showPriceChange && <div className="modal-backdrop price-change-layer"><section className="price-change-modal"><header><span>{selectedLineItem.product.name}</span><strong>現在単価 {selectedLineItem.product.priceInclTax.toLocaleString()}円</strong></header>{discountMode === null ? <div className="discount-mode-selector"><p>値引き方法を選択してください</p><button onClick={() => { setDiscountMode("percent"); setDiscountInput(""); }}>％引き</button><button onClick={() => { setDiscountMode("amount"); setDiscountInput(""); }}>金額値引き</button><button className="price-change-back" onClick={closePriceChange}>戻る</button></div> : <div className="discount-entry"><div className="discount-display"><span>{discountMode === "percent" ? "値引率" : "値引額"}</span><strong>{discountInput ? Number(discountInput).toLocaleString() : "0"}{discountMode === "percent" ? "％" : "円"}</strong><small>変更後単価　{priceChangePreview === null ? "—" : `${priceChangePreview.toLocaleString()}円`}</small></div><div className="discount-keypad">{["7", "8", "9", "4", "5", "6", "1", "2", "3", "0", "00"].map((key) => <button key={key} onClick={() => setDiscountInput((current) => `${current}${key}`.replace(/^0+(?=\d)/, "").slice(0, 7))}>{key}</button>)}<button className="discount-clear" onClick={() => setDiscountInput("")}>C</button><button className="discount-back" onClick={() => { setDiscountMode(null); setDiscountInput(""); }}>戻る</button><button className="discount-apply" disabled={priceChangePreview === null} onClick={applySelectedDiscount}>確定</button></div></div>}</section></div>}
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者番号を入力後、【サインオン】をタッチ</p><input aria-label="責任者番号" inputMode="numeric" maxLength={3} placeholder="責任者番号" value={responsibleNumber} onChange={(event) => setResponsibleNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /><button onPointerUp={() => { const normalized = normalizeResponsibleNumber(responsibleNumber); if (!normalized) return showError("責任者番号を入力してください。"); const member = catalog.staffMembers?.find((candidate) => candidate.responsibleNumber === normalized); if (!member) return showError("登録されていない責任者番号です。商品JSONのstaffMembersを確認してください。"); setResponsibleNumber(normalized); setSignedInResponsibleNumber(member.responsibleNumber); setSignedInUser(member.displayName); setShowSignIn(false); }}>サインオン</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div>{ageFlowState === "staff_pending" && <><button onPointerUp={confirmAge}>確認できた</button><button onPointerUp={() => { localStorage.removeItem(storageKey("age-response")); setAgeCustomerSkipAvailable(false); setAgeFlowState("idle"); setAgeProduct(null); }}>確認できない</button></>}{ageFlowState === "customer_pending" && ageCustomerSkipAvailable && <button className="customer-age-skip" onPointerUp={confirmAge}>客側スキップ</button>}</div></div>}
    {errorModal && <div className="modal-backdrop error-layer"><div className="error-modal"><h2>操作できません</h2><p>{errorModal}</p><div className="error-actions"><button autoFocus onClick={() => { stopOperationSound(); setErrorModal(null); }}>確認</button><button className="stop-alarm" onClick={stopOperationSound}>音停止</button></div></div></div>}
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
  useEffect(() => {
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
      playOperationSound("tap");
    };
    const cancelTap = (event: PointerEvent) => pointers.delete(event.pointerId);
    document.addEventListener("pointerdown", rememberTapStart, { capture: true });
    document.addEventListener("pointerup", playTapFeedback, { capture: true });
    document.addEventListener("pointercancel", cancelTap, { capture: true });
    return () => { document.removeEventListener("pointerdown", rememberTapStart, { capture: true }); document.removeEventListener("pointerup", playTapFeedback, { capture: true }); document.removeEventListener("pointercancel", cancelTap, { capture: true }); };
  }, []);
  const params = new URLSearchParams(window.location.search);
  const role = params.get("role");
  const registerNumber = Number(params.get("register"));
  if ((role !== "staff" && role !== "customer") || !Number.isInteger(registerNumber) || registerNumber < 1 || registerNumber > 4) return <Launcher />;
  return <App role={role} registerNumber={registerNumber} />;
}

if (import.meta.env.PROD && "serviceWorker" in navigator) window.addEventListener("load", () => { void navigator.serviceWorker.register("/sw.js"); });

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
