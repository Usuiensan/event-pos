import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { calculateAutoDiscounts, exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, playOperationSound, speakChangeReady, speakProductPrice, speakReceiptReady, speakSubtotal, type SpeechPlayer } from "./speech.js";
import "./styles.css";

const initialCatalog: EventCatalog = { eventId: "demo-event", products: [
  { productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO001", tabId: "books", displayColor: "#dbeafe" },
  { productCode: "A002", name: "既刊", priceInclTax: 1000, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO002" },
  { productCode: "A003", name: "チューハイ 氷結 レモン", priceInclTax: 79, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO003" },
  { productCode: "A004", name: "トリス レモンハイ", priceInclTax: 108, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO004" },
  { productCode: "A005", name: "獺祭 純米大吟醸", priceInclTax: 1298, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO005" },
  { productCode: "A006", name: "いろはす 2L", priceInclTax: 98, taxRate: 8, saleState: "on_sale", internalToken: "P1DEMO006" },
  { productCode: "A007", name: "国鉄杯Ⅲ", priceInclTax: 1000, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO007" },
  { productCode: "A008", name: "新刊ポストカード", priceInclTax: 300, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO008" },
  { productCode: "A009", name: "R18新刊", priceInclTax: 800, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO009", ageCheck: "18", tabId: "adult", displayColor: "#fbcfe8" },
], quickEntries: [
  { id: "set-1", label: "新刊2冊セット", components: [{ productCode: "A001", quantity: 2 }] },
  { id: "r18-1", label: "R18新刊", components: [{ productCode: "A009", quantity: 1 }] },
], productTabs: [{ id: "books", label: "新刊・既刊", color: "#dbeafe" }, { id: "adult", label: "成人向け", color: "#fbcfe8" }], autoDiscountRules: [{ id: "new-book-pair", label: "新刊2冊まとめ値引き", requiredProducts: [{ productCode: "A001", quantity: 2 }], discountYen: 100, priority: 10 }] };

function App() {
  const role = new URLSearchParams(window.location.search).get("role") === "customer" ? "customer" : "staff";
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<Array<{ product: ProductDefinition; quantity: number; cancelled?: boolean }>>([]);
  const [now, setNow] = useState(() => new Date());
  const [responsibleNumber, setResponsibleNumber] = useState("");
  const [signedInResponsibleNumber, setSignedInResponsibleNumber] = useState("---");
  const [signedInUser] = useState(() => localStorage.getItem("event-pos-staff-name") ?? "テスト管理者");
  const [speakerId, setSpeakerId] = useState(() => Number(localStorage.getItem("event-pos-speaker") ?? 3));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<{ name: string; quantity: number; unitPrice: number } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [productTab, setProductTab] = useState("all");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
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
  const ageRequirement = (product: ProductDefinition): 18 | 20 | null => product.ageCheck === "18" ? 18 : product.ageCheck === "20" ? 20 : product.ageCheck === "none" ? null : /R18|18禁|成人向け/.test(product.name) ? 18 : /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name) ? 20 : null;
  const isAgeRestricted = (product: ProductDefinition) => ageRequirement(product) !== null;
  const showError = (message: string) => { playOperationSound("error"); setErrorModal(message); };
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const headerDateTime = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeCart = cart.filter((line) => !line.cancelled);
  const canCancelRegistration = activeCart.length > 0;
  const autoDiscounts = calculateAutoDiscounts(activeCart.reduce((quantities, line) => quantities.set(line.product.productCode, (quantities.get(line.product.productCode) ?? 0) + line.quantity), new Map<string, number>()), catalog.autoDiscountRules ?? []);
  const autoDiscountYen = autoDiscounts.reduce((sum, discount) => sum + discount.discountYen, 0);
  const customerRequiresAge = activeCart.some((line) => isAgeRestricted(line.product)) && customerAgeNotice !== "verified" && !customerAgeAcknowledged;
  const visibleProducts = catalog.products.filter((product) => productTab === "all" || product.tabId === productTab);
  const total = activeCart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0) - autoDiscountYen;
  useEffect(() => {
    const sync = () => { try { const saved = JSON.parse(localStorage.getItem("event-pos-cart") ?? "[]") as Array<{ productCode: string; quantity: number; cancelled?: boolean }>; setCart(saved.flatMap((item) => { const product = catalog.products.find((candidate) => candidate.productCode === item.productCode); return product ? [{ product, quantity: item.quantity, ...(item.cancelled ? { cancelled: true } : {}) }] : []; })); } catch { /* ignore malformed preview state */ } };
    sync(); window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [catalog.products]);
  useEffect(() => { if (role === "staff") localStorage.setItem("event-pos-cart", JSON.stringify(cart.map((line) => ({ productCode: line.product.productCode, quantity: line.quantity, cancelled: line.cancelled })))); }, [cart, role]);
  useEffect(() => { if (role !== "customer") return; const syncAge = () => { const value = localStorage.getItem("event-pos-age-check"); setCustomerAgeNotice(value?.startsWith("verified") ? "verified" : value?.startsWith("required") ? "required" : null); setCustomerAgeMinimum(value?.endsWith(":18") ? 18 : 20); }; syncAge(); window.addEventListener("storage", syncAge); return () => window.removeEventListener("storage", syncAge); }, [role]);
  useEffect(() => { if (role !== "customer") return; const syncHighlight = (event: StorageEvent) => { if (event.key !== "event-pos-line-highlight" || !event.newValue) return; try { const value = JSON.parse(event.newValue) as { productCode?: string }; if (!value.productCode) return; setHighlighted(value.productCode); window.setTimeout(() => setHighlighted((current) => current === value.productCode ? null : current), 1100); } catch { /* ignore malformed preview state */ } }; window.addEventListener("storage", syncHighlight); return () => window.removeEventListener("storage", syncHighlight); }, [role]);
  useEffect(() => { if (role !== "staff" || !ageProduct || ageFlowState !== "customer_pending") return; const onCustomerAge = () => { if (localStorage.getItem("event-pos-age-response") === "yes") { localStorage.removeItem("event-pos-age-response"); setAgeFlowState("staff_pending"); } }; window.addEventListener("storage", onCustomerAge); onCustomerAge(); return () => window.removeEventListener("storage", onCustomerAge); }, [role, ageProduct, ageFlowState]);
  useEffect(() => { const timer = window.setInterval(() => setNow(new Date()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (role !== "staff") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (showSignIn || isFormInput) return;
      if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setInputBuffer((value) => value + event.key); return; }
      if (event.key === "Escape") { setInputBuffer(""); return; }
      if (event.key === "Enter" && inputBuffer) {
        event.preventDefault();
        if (total === 0) { const product = inputBuffer.length >= 8 ? catalog.products.find((candidate) => candidate.productCode === inputBuffer) : undefined; setInputBuffer(""); if (product) addProduct(product); else showError(inputBuffer.length >= 8 ? "商品コードが見つかりません。登録済みコードを入力してください。" : "会計待ちです。商品を登録してから預り金を入力してください。"); return; }
        const amount = Number(inputBuffer);
        if (amount >= total && amount - total < 10000) { setReceived(amount); setPaymentFinished(true); setInputBuffer(""); playOperationSound("complete"); speakReceiptReady(speech); }
        else { setInputBuffer(""); showError(amount >= total ? "お釣りが10,000円以上になる預り金は入力できません。" : "預り金が不足しています。合計金額以上を入力してください。"); }
        return;
      }
      if (paymentFinished && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); setAgeVerified(false); setAgeVerifiedMinimum(0); setAgeFlowState("idle"); localStorage.removeItem("event-pos-age-check"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inputBuffer, paymentFinished, role, showSignIn, speech, total, catalog.products]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then(setCatalog).catch(() => { showError("カタログを読み込めません。初期値を表示しています"); }); }, []);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const highlightLine = (productCode: string) => { setHighlighted(productCode); localStorage.setItem("event-pos-line-highlight", JSON.stringify({ productCode, at: Date.now() })); window.setTimeout(() => setHighlighted((current) => current === productCode ? null : current), 1100); };
  const addProduct = (product: ProductDefinition, quantity = 1, announce = true, ageCheckBypass = false) => {
    if (product.saleState !== "on_sale") return showError("この商品は販売停止中のため登録できません。");
    const requiredAge = ageRequirement(product);
    if (!ageCheckBypass && requiredAge && (!ageVerified || ageVerifiedMinimum < requiredAge)) { localStorage.setItem("event-pos-age-check", `required:${requiredAge}`); setAgeCustomerSkipAvailable(true); setAgeFlowState("customer_pending"); return setAgeProduct(product); }
    if (paymentFinished) { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); setAgeVerified(false); setAgeVerifiedMinimum(0); setAgeFlowState("idle"); localStorage.removeItem("event-pos-age-check"); }
    setLastAdded({ name: product.name, quantity, unitPrice: product.priceInclTax });
    playOperationSound("register");
    setCart((current) => {
      const existing = current.findIndex((line) => !line.cancelled && line.product.productCode === product.productCode);
      if (existing < 0) return [...current, { product, quantity }];
      highlightLine(product.productCode);
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
  const setQuantity = (productCode: string) => { const value = window.prompt("数量を入力", "1"); const quantity = Number(value); if (Number.isSafeInteger(quantity) && quantity > 0) { setCart((current) => current.map((line) => line.product.productCode === productCode ? { ...line, quantity } : line)); highlightLine(productCode); } };
  const cancelRegistration = () => { setCart([]); setLastAdded(null); setReceived(0); setPaymentFinished(false); setAgeVerified(false); setAgeProduct(null); localStorage.removeItem("event-pos-age-check"); };
  const selectedLineItem = selectedLine ? cart.find((line) => line.product.productCode === selectedLine) : undefined;
  const changeSelectedPrice = () => { if (!selectedLineItem) return; const value = window.prompt("売価を入力", String(selectedLineItem.product.priceInclTax)); const price = Number(value); if (Number.isSafeInteger(price) && price >= 0) setCart((current) => current.map((line) => line.product.productCode === selectedLine ? { ...line, product: { ...line.product, priceInclTax: price } } : line)); setSelectedLine(null); };
  const confirmAge = () => { const verifiedMinimum = ageProduct ? (ageRequirement(ageProduct) ?? 20) : 20; setAgeVerified(true); setAgeVerifiedMinimum(verifiedMinimum); setAgeCustomerSkipAvailable(false); setAgeFlowState("idle"); localStorage.setItem("event-pos-age-check", `verified:${verifiedMinimum}`); if (ageProduct) { const product = ageProduct; setAgeProduct(null); addProduct(product, 1, true, true); } };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).then(() => { setCart([]); }).catch((error) => showError(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { showError(error instanceof Error ? error.message : "JSONが不正です"); } };
  if (role === "customer") return <main className="pos-screen customer-screen"><section className="customer-lines">{(customerAgeNotice || customerRequiresAge) && <div className={`age-notice ${customerAgeNotice === "verified" ? "" : "customer-age-prompt"} ${customerAgeNotice ?? "required"}`}><strong>{customerAgeNotice === "verified" ? `年齢確認済み（${customerAgeMinimum}歳以上）` : `あなたは${customerAgeMinimum}歳以上ですか？`}</strong>{customerAgeNotice !== "verified" && <button className="customer-age-yes" onPointerUp={() => { localStorage.setItem("event-pos-age-response", "yes"); localStorage.setItem("event-pos-age-check", "verified"); setCustomerAgeAcknowledged(true); setCustomerAgeNotice(null); }}>はい</button>}</div>}{cart.length === 0 ? <div className="customer-empty">いらっしゃいませ</div> : cart.map((line, index) => <div className={`customer-line ${line.cancelled ? "cancelled-line" : ""} ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>@{line.product.priceInclTax.toLocaleString()}</span><span>{line.quantity}点</span></div>)}{autoDiscounts.map((discount) => <div className="customer-discount" key={discount.ruleId}><span>{discount.label}{discount.applications > 1 ? ` ×${discount.applications}` : ""}</span><strong>-{discount.discountYen.toLocaleString()}円</strong></div>)}</section><footer className="customer-total"><span>合計　{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></main>;
  return <main className="pos-screen register-shell">
    <header className="register-header"><time>{headerDateTime}</time><p className="operation-guide">商品を登録してください。<br />登録が終わったら、預り金額をテンキーで入力してEnterを押します。</p><p className="signed-in-user"><span>{signedInUser}</span><span>責任者番号 {signedInResponsibleNumber}</span></p></header>
    <section className="toolbar"><button className="business-menu-button" onClick={() => setShowBusinessMenu(true)}>業務メニュー</button><label>音声話者<select value={speakerId} onChange={(event) => { const next = Number(event.target.value); setSpeakerId(next); localStorage.setItem("event-pos-speaker", String(next)); speech.setSpeaker(next); }}><option value="3">ずんだもん</option><option value="2">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label><button className="cancel-top" disabled={!canCancelRegistration} onClick={() => { if (canCancelRegistration) setCancelConfirm(true); }}>登録中止</button></section>
    {panel === "products" ? <section className="product-panel"><aside className="mini-cart"><h2>登録明細</h2><div className="mini-cart-head"><span>商品名</span><span>数量</span><span>単価</span></div><div className="mini-cart-lines">{cart.length === 0 ? <div className="mini-cart-empty">登録待ち</div> : cart.map((line, index) => <div role="button" tabIndex={0} onPointerUp={() => setSelectedLine(line.product.productCode)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(line.product.productCode); }} className={`mini-cart-line ${line.cancelled ? "cancelled-line" : ""} ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span></div>)}</div><footer><span>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></aside><div className="product-picker"><div className="product-tabs"><button className={productTab === "all" ? "active" : ""} onPointerUp={() => setProductTab("all")}>すべて</button>{(catalog.productTabs ?? []).map((tab) => <button key={tab.id} className={productTab === tab.id ? "active" : ""} style={tab.color ? { backgroundColor: tab.color } : undefined} onPointerUp={() => setProductTab(tab.id)}>{tab.label}</button>)}</div><div className="product-grid">{visibleProducts.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} style={product.displayColor ? { backgroundColor: product.displayColor } : undefined} onPointerUp={() => addProduct(product)}><strong>{product.name}</strong><span>{product.priceInclTax.toLocaleString()}円</span></button>)}{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onPointerUp={() => addQuick(quick)}><strong>{quick.label}</strong></button>)}</div></div></section> : <section className="detail-panel"><h2>登録明細 A</h2><div className="detail-head"><span>NO.</span><span>属性</span><span>商品名</span><span>数量</span><span>単価</span><span>値引</span><span>操作</span></div>{cart.map((line, index) => <div role="button" tabIndex={0} onPointerUp={() => setSelectedLine(line.product.productCode)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(line.product.productCode); }} className={`detail-row ${line.cancelled ? "cancelled-line" : ""} ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>—</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>—</span><span>タップして操作</span></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="staff-bottom">{autoDiscounts.map((discount) => <div className="auto-discount" key={discount.ruleId}>{discount.label}{discount.applications > 1 ? ` ×${discount.applications}` : ""}　-{discount.discountYen.toLocaleString()}円</div>)}<div className="last-added">{lastAdded ? <><strong>{lastAdded.name}</strong><span>{lastAdded.quantity}個　{lastAdded.unitPrice.toLocaleString()}</span></> : <span>登録待ち</span>}</div><div className="staff-total"><span>合計</span><strong>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点　{total.toLocaleString()}円</strong></div><div className="payment-controls"><button onClick={() => { speakSubtotal(speech, `合計金額は ${formatJapaneseYenSpeech(total)}`); }}>小計</button><span className="payment-result">お預り {received.toLocaleString()}円　お釣り {Math.max(0, received - total).toLocaleString()}円</span></div></section>
    <button className="panel-switch" onClick={() => setPanel((current) => current === "detail" ? "products" : "detail")}>{panel === "detail" ? "商品登録へ" : "登録明細へ"}</button>
    {inputBuffer && <div className="cash-popup"><span>お預り金額</span><strong>{Number(inputBuffer).toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><button onClick={() => fileRef.current?.click()}>商品JSONインポート</button><button onClick={() => showError("返金は責任者権限が必要です。")}>返金</button><button onClick={() => showError("再印刷は責任者権限が必要です。")}>再印刷</button><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {selectedLineItem && <div className="modal-backdrop"><div className="line-menu"><h2>{selectedLineItem.product.name}</h2><button onClick={() => { setCart((current) => current.map((line) => line.product.productCode === selectedLine ? { ...line, cancelled: true } : line)); playOperationSound("cancel"); highlightLine(selectedLineItem.product.productCode); setSelectedLine(null); }}>取り消し</button><button onClick={() => { setQuantity(selectedLineItem.product.productCode); setSelectedLine(null); }}>数量変更</button><button onClick={changeSelectedPrice}>売価変更</button><button onClick={() => setSelectedLine(null)}>閉じる</button></div></div>}
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者番号を入力後、【サインオン】をタッチ</p><input aria-label="責任者番号" inputMode="numeric" maxLength={3} placeholder="責任者番号" value={responsibleNumber} onChange={(event) => setResponsibleNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /><button onPointerUp={() => { if (!/^\d{3}$/.test(responsibleNumber)) return showError("責任者番号を3桁で入力してください。"); setSignedInResponsibleNumber(responsibleNumber); setShowSignIn(false); }}>サインオン</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div>{ageFlowState === "staff_pending" && <><button onPointerUp={confirmAge}>確認できた</button><button onPointerUp={() => { localStorage.removeItem("event-pos-age-response"); setAgeCustomerSkipAvailable(false); setAgeFlowState("idle"); setAgeProduct(null); }}>確認できない</button></>}{ageFlowState === "customer_pending" && ageCustomerSkipAvailable && <button className="customer-age-skip" onPointerUp={confirmAge}>客側スキップ</button>}</div></div>}
    {errorModal && <div className="modal-backdrop error-layer"><div className="error-modal"><h2>操作できません</h2><p>{errorModal}</p><button autoFocus onClick={() => setErrorModal(null)}>確認</button></div></div>}
    {cancelConfirm && <div className="modal-backdrop error-layer"><div className="error-modal cancel-confirm"><h2>登録中止</h2><p>本当に登録を中止しますか？</p><button onClick={() => { cancelRegistration(); setCancelConfirm(false); }}>中止する</button><button onClick={() => setCancelConfirm(false)}>戻る</button></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
