import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, speakChangeReady, speakProductPrice, speakReceiptReady, speakSubtotal, type SpeechPlayer } from "./speech.js";
import "./styles.css";

const initialCatalog: EventCatalog = { eventId: "demo-event", products: [
  { productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO001" },
  { productCode: "A002", name: "既刊", priceInclTax: 1000, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO002" },
  { productCode: "A003", name: "チューハイ 氷結 レモン", priceInclTax: 79, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO003" },
  { productCode: "A004", name: "トリス レモンハイ", priceInclTax: 108, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO004" },
  { productCode: "A005", name: "獺祭 純米大吟醸", priceInclTax: 1298, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO005" },
  { productCode: "A006", name: "いろはす 2L", priceInclTax: 98, taxRate: 8, saleState: "on_sale", internalToken: "P1DEMO006" },
  { productCode: "A007", name: "国鉄杯Ⅲ", priceInclTax: 1000, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO007" },
  { productCode: "A008", name: "新刊ポストカード", priceInclTax: 300, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO008" },
  { productCode: "A009", name: "R18新刊", priceInclTax: 800, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO009" },
], quickEntries: [
  { id: "set-1", label: "新刊2冊セット", components: [{ productCode: "A001", quantity: 2 }] },
  { id: "r18-1", label: "R18新刊", components: [{ productCode: "A009", quantity: 1 }] },
] };

function App() {
  const role = new URLSearchParams(window.location.search).get("role") === "customer" ? "customer" : "staff";
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<Array<{ product: ProductDefinition; quantity: number; cancelled?: boolean }>>([]);
  const [message, setMessage] = useState("会計待ち");
  const [loading, setLoading] = useState(true);
  const [speakerId, setSpeakerId] = useState(() => Number(localStorage.getItem("event-pos-speaker") ?? 1));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<{ name: string; quantity: number; unitPrice: number } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
  const [errorModal, setErrorModal] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [selectedLine, setSelectedLine] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [ageProduct, setAgeProduct] = useState<ProductDefinition | null>(null);
  const [ageVerified, setAgeVerified] = useState(false);
  const [customerAgeNotice, setCustomerAgeNotice] = useState<"required" | "verified" | null>(null);
  const [customerAgeMinimum, setCustomerAgeMinimum] = useState<18 | 20>(20);
  const [received, setReceived] = useState(0);
  const [inputBuffer, setInputBuffer] = useState("");
  const [paymentFinished, setPaymentFinished] = useState(false);
  const ageRequirement = (product: ProductDefinition): 18 | 20 | null => /R18|18禁|成人向け/.test(product.name) ? 18 : /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name) ? 20 : null;
  const isAgeRestricted = (product: ProductDefinition) => ageRequirement(product) !== null;
  const showError = (message: string) => setErrorModal(message);
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeCart = cart.filter((line) => !line.cancelled);
  const total = activeCart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0);
  useEffect(() => {
    const sync = () => { try { const saved = JSON.parse(localStorage.getItem("event-pos-cart") ?? "[]") as Array<{ productCode: string; quantity: number; cancelled?: boolean }>; setCart(saved.flatMap((item) => { const product = catalog.products.find((candidate) => candidate.productCode === item.productCode); return product ? [{ product, quantity: item.quantity, ...(item.cancelled ? { cancelled: true } : {}) }] : []; })); } catch { /* ignore malformed preview state */ } };
    sync(); window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [catalog.products]);
  useEffect(() => { if (role === "staff") localStorage.setItem("event-pos-cart", JSON.stringify(cart.map((line) => ({ productCode: line.product.productCode, quantity: line.quantity, cancelled: line.cancelled })))); }, [cart, role]);
  useEffect(() => { if (role !== "customer") return; const syncAge = () => { const value = localStorage.getItem("event-pos-age-check"); setCustomerAgeNotice(value === "verified" ? "verified" : value?.startsWith("required") ? "required" : null); setCustomerAgeMinimum(value?.endsWith(":18") ? 18 : 20); }; syncAge(); window.addEventListener("storage", syncAge); return () => window.removeEventListener("storage", syncAge); }, [role]);
  useEffect(() => { if (role !== "staff") return; const onKey = (event: KeyboardEvent) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setInputBuffer((value) => value + event.key); return; } if (event.key === "Escape") { setInputBuffer(""); return; } if (event.key === "Enter" && inputBuffer) { event.preventDefault(); if (total === 0) { const product = inputBuffer.length >= 8 ? catalog.products.find((candidate) => candidate.productCode === inputBuffer) : undefined; setInputBuffer(""); if (product) addProduct(product); else showError(inputBuffer.length >= 8 ? "商品コードが見つかりません。登録済みコードを入力してください。" : "会計待ちです。商品を登録してから預り金を入力してください。"); return; } const amount = Number(inputBuffer); if (amount >= total) { setReceived(amount); setPaymentFinished(true); setInputBuffer(""); speakReceiptReady(speech); setMessage("現計・レシート発行済み"); } else { setInputBuffer(""); showError("預り金が不足しています。合計金額以上を入力してください。"); } return; } if (paymentFinished && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); setAgeVerified(false); localStorage.removeItem("event-pos-age-check"); setMessage("会計待ち"); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [inputBuffer, paymentFinished, role, speech, total, catalog.products]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then((loaded) => { setCatalog(loaded); setLoading(false); }).catch(() => { setMessage("カタログを読み込めません。初期値を表示しています"); setLoading(false); }); }, []);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const addProduct = (product: ProductDefinition, quantity = 1) => {
    if (product.saleState !== "on_sale") return showError("この商品は販売停止中のため登録できません。");
    if (isAgeRestricted(product) && !ageVerified) { localStorage.setItem("event-pos-age-check", `required:${ageRequirement(product)}`); return setAgeProduct(product); }
    if (paymentFinished) { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); setAgeVerified(false); localStorage.removeItem("event-pos-age-check"); }
    setLastAdded({ name: product.name, quantity, unitPrice: product.priceInclTax });
    setCart((current) => {
      const existing = current.findIndex((line) => !line.cancelled && line.product.productCode === product.productCode);
      if (existing < 0) return [...current, { product, quantity }];
      setHighlighted(product.productCode); window.setTimeout(() => setHighlighted(null), 900);
      return current.map((line, index) => index === existing ? { ...line, quantity: line.quantity + quantity } : line);
    });
    speakProductPrice(speech, formatJapaneseYenSpeech(product.priceInclTax));
    setMessage(`${product.name}を登録しました`);
  };
  const addQuick = (quick: QuickEntry) => {
    if (quick.productCode) { const p = catalog.products.find((item) => item.productCode === quick.productCode); if (p) addProduct(p, quick.quantity ?? 1); return; }
    for (const component of quick.components ?? []) { const p = catalog.products.find((item) => item.productCode === component.productCode); if (p) addProduct(p, component.quantity); }
  };
  const changeQuantity = (productCode: string, delta: number) => setCart((current) => current.flatMap((line) => line.product.productCode === productCode ? (line.quantity + delta > 0 ? [{ ...line, quantity: line.quantity + delta }] : []) : [line]));
  const setQuantity = (productCode: string) => { const value = window.prompt("数量を入力", "1"); const quantity = Number(value); if (Number.isSafeInteger(quantity) && quantity > 0) setCart((current) => current.map((line) => line.product.productCode === productCode ? { ...line, quantity } : line)); };
  const cancelRegistration = () => { setCart([]); setLastAdded(null); setReceived(0); setPaymentFinished(false); setAgeVerified(false); setAgeProduct(null); localStorage.removeItem("event-pos-age-check"); setMessage("登録を中止しました"); };
  const selectedLineItem = selectedLine ? cart.find((line) => line.product.productCode === selectedLine) : undefined;
  const changeSelectedPrice = () => { if (!selectedLineItem) return; const value = window.prompt("売価を入力", String(selectedLineItem.product.priceInclTax)); const price = Number(value); if (Number.isSafeInteger(price) && price >= 0) setCart((current) => current.map((line) => line.product.productCode === selectedLine ? { ...line, product: { ...line.product, priceInclTax: price } } : line)); setSelectedLine(null); };
  const confirmAge = () => { setAgeVerified(true); localStorage.setItem("event-pos-age-check", "verified"); if (ageProduct) { const product = ageProduct; setAgeProduct(null); addProduct(product); } };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).then(() => { setCart([]); setMessage("商品JSONを保存しました"); }).catch((error) => setMessage(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { setMessage(error instanceof Error ? error.message : "JSONが不正です"); } };
  if (role === "customer") return <main className="pos-screen customer-screen"><header className="pos-header"><span>登録明細</span><span>お客様画面</span></header><section className="customer-lines">{customerAgeNotice && <div className={`age-notice ${customerAgeNotice}`}><strong>{customerAgeNotice === "required" ? `${customerAgeMinimum}歳以上の年齢確認が必要です` : `年齢確認済み（${customerAgeMinimum}歳以上）`}</strong></div>}{cart.length === 0 ? <div className="customer-empty">いらっしゃいませ</div> : cart.map((line, index) => <div className={`customer-line ${line.cancelled ? "cancelled-line" : ""}`} key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>@{line.product.priceInclTax.toLocaleString()}</span><span>{line.quantity}点</span></div>)}</section><footer className="customer-total"><span>合計　{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></main>;
  return <main className="pos-screen register-shell">
    <header><p className="eyebrow">event-pos / {catalog.eventId}</p><h1>{loading ? "カタログ読み込み中" : message}</h1></header>
    <section className="toolbar"><button className="business-menu-button" onClick={() => setShowBusinessMenu(true)}>業務メニュー</button><label>音声話者<select value={speakerId} onChange={(event) => { const next = Number(event.target.value); setSpeakerId(next); localStorage.setItem("event-pos-speaker", String(next)); speech.setSpeaker(next); }}><option value="1">ずんだもん</option><option value="3">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label><button className="cancel-top" onClick={() => setCancelConfirm(true)}>登録中止</button></section>
    {panel === "products" ? <section className="product-grid">{catalog.products.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} onPointerUp={() => addProduct(product)}><strong>{product.name}</strong><span>{product.priceInclTax.toLocaleString()}円</span></button>)}{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onPointerUp={() => addQuick(quick)}><strong>{quick.label}</strong></button>)}</section> : <section className="detail-panel"><h2>登録明細 A</h2><div className="detail-head"><span>NO.</span><span>属性</span><span>商品名</span><span>数量</span><span>単価</span><span>値引</span><span>操作</span></div>{cart.map((line, index) => <div role="button" tabIndex={0} onPointerUp={() => setSelectedLine(line.product.productCode)} onKeyDown={(event) => { if (event.key === "Enter") setSelectedLine(line.product.productCode); }} className={`detail-row ${line.cancelled ? "cancelled-line" : ""} ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>—</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>—</span><span>タップして操作</span></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="staff-bottom"><div className="last-added">{lastAdded ? <><strong>{lastAdded.name}</strong><span>{lastAdded.quantity}個　{lastAdded.unitPrice.toLocaleString()}</span></> : <span>登録待ち</span>}</div><div className="staff-total"><span>合計</span><strong>{activeCart.reduce((sum, line) => sum + line.quantity, 0)}点　{total.toLocaleString()}円</strong></div><div className="payment-controls"><button onClick={() => { speakSubtotal(speech, `合計金額は ${formatJapaneseYenSpeech(total)}`); setMessage(`合計金額は${total.toLocaleString()}円です`); }}>小計</button><span className="payment-result">お預り {received.toLocaleString()}円　お釣り {Math.max(0, received - total).toLocaleString()}円</span></div></section>
    <button className="panel-switch" onClick={() => setPanel((current) => current === "detail" ? "products" : "detail")}>{panel === "detail" ? "商品登録へ" : "登録明細へ"}</button>
    {inputBuffer && <div className="cash-popup"><span>お預り金額</span><strong>{Number(inputBuffer).toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><button onClick={() => fileRef.current?.click()}>商品JSONインポート</button><button onClick={() => showError("返金は責任者権限が必要です。")}>返金</button><button onClick={() => showError("再印刷は責任者権限が必要です。")}>再印刷</button><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {selectedLineItem && <div className="modal-backdrop"><div className="line-menu"><h2>{selectedLineItem.product.name}</h2><button onClick={() => { setCart((current) => current.map((line) => line.product.productCode === selectedLine ? { ...line, cancelled: true } : line)); setSelectedLine(null); }}>取り消し</button><button onClick={() => { setQuantity(selectedLineItem.product.productCode); setSelectedLine(null); }}>数量変更</button><button onClick={changeSelectedPrice}>売価変更</button><button onClick={() => setSelectedLine(null)}>閉じる</button></div></div>}
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者番号を入力後、【サインオン】をタッチ</p><input aria-label="責任者番号" placeholder="責任者番号" /><button onPointerUp={() => setShowSignIn(false)}>サインオン</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div><button onPointerUp={confirmAge}>確認済み・登録</button><button onPointerUp={() => setAgeProduct(null)}>確認できない</button></div></div>}
    {errorModal && <div className="modal-backdrop error-layer"><div className="error-modal"><h2>操作できません</h2><p>{errorModal}</p><button autoFocus onClick={() => setErrorModal(null)}>確認</button></div></div>}
    {cancelConfirm && <div className="modal-backdrop error-layer"><div className="error-modal cancel-confirm"><h2>登録中止</h2><p>本当に登録を中止しますか？</p><button onClick={() => { cancelRegistration(); setCancelConfirm(false); }}>中止する</button><button onClick={() => setCancelConfirm(false)}>戻る</button></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
