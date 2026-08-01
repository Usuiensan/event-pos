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
], quickEntries: [{ id: "set-1", label: "新刊2冊セット", components: [{ productCode: "A001", quantity: 2 }] }] };

function App() {
  const role = new URLSearchParams(window.location.search).get("role") === "customer" ? "customer" : "staff";
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<Array<{ product: ProductDefinition; quantity: number }>>([]);
  const [message, setMessage] = useState("会計待ち");
  const [loading, setLoading] = useState(true);
  const [speakerId, setSpeakerId] = useState(() => Number(localStorage.getItem("event-pos-speaker") ?? 1));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<{ name: string; quantity: number; unitPrice: number } | null>(null);
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showBusinessMenu, setShowBusinessMenu] = useState(false);
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
  const today = new Date();
  const twentiethBirthday = new Date(today.getFullYear() - (ageProduct ? ageRequirement(ageProduct) ?? 20 : 20), today.getMonth(), today.getDate());
  const formatDateWareki = (date: Date) => { const year = date.getFullYear(); if (year >= 2019) return `令和${year - 2018}年${date.getMonth() + 1}月${date.getDate()}日`; if (year >= 1989) return `平成${year - 1988}年${date.getMonth() + 1}月${date.getDate()}日`; return `${year}年${date.getMonth() + 1}月${date.getDate()}日`; };
  const formatDateJa = (date: Date) => `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = cart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0);
  useEffect(() => {
    const sync = () => { try { const saved = JSON.parse(localStorage.getItem("event-pos-cart") ?? "[]") as Array<{ productCode: string; quantity: number }>; setCart(saved.flatMap((item) => { const product = catalog.products.find((candidate) => candidate.productCode === item.productCode); return product ? [{ product, quantity: item.quantity }] : []; })); } catch { /* ignore malformed preview state */ } };
    sync(); window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [catalog.products]);
  useEffect(() => { if (role === "staff") localStorage.setItem("event-pos-cart", JSON.stringify(cart.map((line) => ({ productCode: line.product.productCode, quantity: line.quantity })))); }, [cart, role]);
  useEffect(() => { if (role !== "customer") return; const syncAge = () => { const value = localStorage.getItem("event-pos-age-check"); setCustomerAgeNotice(value === "verified" ? "verified" : value?.startsWith("required") ? "required" : null); setCustomerAgeMinimum(value?.endsWith(":18") ? 18 : 20); }; syncAge(); window.addEventListener("storage", syncAge); return () => window.removeEventListener("storage", syncAge); }, [role]);
  useEffect(() => { if (role !== "staff") return; const onKey = (event: KeyboardEvent) => { if (/^[0-9]$/.test(event.key)) { event.preventDefault(); setInputBuffer((value) => value + event.key); return; } if (event.key === "Enter" && inputBuffer) { event.preventDefault(); const amount = Number(inputBuffer); if (amount >= total && total > 0) { setReceived(amount); setPaymentFinished(true); setInputBuffer(""); speakReceiptReady(speech); setMessage("現計・レシート発行済み"); } return; } if (paymentFinished && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); localStorage.removeItem("event-pos-age-check"); setMessage("会計待ち"); } }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [inputBuffer, paymentFinished, role, speech, total]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then((loaded) => { setCatalog(loaded); setLoading(false); }).catch(() => { setMessage("カタログを読み込めません。初期値を表示しています"); setLoading(false); }); }, []);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const addProduct = (product: ProductDefinition, quantity = 1) => {
    if (product.saleState !== "on_sale") return setMessage("販売停止中の商品です");
    if (isAgeRestricted(product) && !ageVerified) { localStorage.setItem("event-pos-age-check", `required:${ageRequirement(product)}`); return setAgeProduct(product); }
    if (paymentFinished) { setCart([]); setLastAdded(null); setPaymentFinished(false); setReceived(0); }
    setLastAdded({ name: product.name, quantity, unitPrice: product.priceInclTax });
    setCart((current) => {
      const existing = current.findIndex((line) => line.product.productCode === product.productCode);
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
  const cancelRegistration = () => { setCart([]); setLastAdded(null); setReceived(0); setPaymentFinished(false); localStorage.removeItem("event-pos-age-check"); setMessage("登録を中止しました"); };
  const confirmAge = () => { setAgeVerified(true); localStorage.setItem("event-pos-age-check", "verified"); if (ageProduct) { const product = ageProduct; setAgeProduct(null); addProduct(product); } };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).then(() => { setCart([]); setMessage("商品JSONを保存しました"); }).catch((error) => setMessage(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { setMessage(error instanceof Error ? error.message : "JSONが不正です"); } };
  if (role === "customer") return <main className="pos-screen customer-screen"><header className="pos-header"><span>登録明細</span><span>お客様画面</span></header><section className="customer-lines">{customerAgeNotice && <div className={`age-notice ${customerAgeNotice}`}><strong>{customerAgeNotice === "required" ? `${customerAgeMinimum}歳以上の年齢確認が必要です` : `年齢確認済み（${customerAgeMinimum}歳以上）`}</strong><span>{customerAgeNotice === "required" ? "店員が確認しています" : "確認方式：容貌確認"}</span></div>}{cart.length === 0 ? <div className="customer-empty">いらっしゃいませ</div> : cart.map((line, index) => <div className="customer-line" key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>{line.quantity}点</span></div>)}</section><footer className="customer-total"><span>合計　{cart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></main>;
  return <main className="pos-screen register-shell">
    <header><p className="eyebrow">event-pos / {catalog.eventId}</p><h1>{loading ? "カタログ読み込み中" : message}</h1></header>
    <section className="toolbar"><button onClick={() => setPanel("detail")}>登録明細へ</button><button onClick={() => setPanel("products")}>商品登録へ</button><button className="business-menu-button" onClick={() => setShowBusinessMenu(true)}>業務メニュー</button><label>音声話者<select value={speakerId} onChange={(event) => { const next = Number(event.target.value); setSpeakerId(next); localStorage.setItem("event-pos-speaker", String(next)); speech.setSpeaker(next); }}><option value="1">ずんだもん</option><option value="3">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label></section>
    {panel === "products" ? <section className="product-grid"><h2>商品登録 B</h2>{catalog.products.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} onClick={() => addProduct(product)}><strong>{product.name}</strong><span>{product.priceInclTax.toLocaleString()}円</span><small>{product.productCode}</small></button>)}<h2>ワンタップ</h2>{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><strong>{quick.label}</strong><small>{quick.id}</small></button>)}</section> : <section className="detail-panel"><h2>登録明細 A</h2><div className="detail-head"><span>NO.</span><span>属性</span><span>商品名</span><span>数量</span><span>単価</span><span>値引</span><span>操作</span></div>{cart.map((line, index) => <div className={`detail-row ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>—</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}</span><span>—</span><span className="line-actions"><button onClick={() => changeQuantity(line.product.productCode, -1)}>−</button><button onClick={() => changeQuantity(line.product.productCode, 1)}>＋</button><button onClick={() => setQuantity(line.product.productCode)}>×</button><button onClick={() => setCart((current) => current.filter((item) => item.product.productCode !== line.product.productCode))}>取消</button></span></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="staff-bottom"><div className="last-added">{lastAdded ? <><strong>{lastAdded.name}</strong><span>{lastAdded.quantity}個　{lastAdded.unitPrice.toLocaleString()}</span></> : <span>登録待ち</span>}</div><div className="staff-total"><span>合計</span><strong>{cart.reduce((sum, line) => sum + line.quantity, 0)}点　{total.toLocaleString()}円</strong></div><div className="payment-controls"><button onClick={() => { speakSubtotal(speech, `合計金額は ${formatJapaneseYenSpeech(total)}`); setMessage(`合計金額は${total.toLocaleString()}円です`); }}>小計</button><button className="cancel-registration" onClick={cancelRegistration}>登録中止</button><span className="payment-result">お預り {received.toLocaleString()}円　お釣り {Math.max(0, received - total).toLocaleString()}円</span></div></section>
    {inputBuffer && <div className="cash-popup"><span>お預り金額</span><strong>{Number(inputBuffer).toLocaleString()}円</strong><small>Enterで現計・レシート発行</small></div>}
    {showBusinessMenu && <div className="modal-backdrop"><div className="business-menu"><h2>業務メニュー</h2><button onClick={() => fileRef.current?.click()}>商品JSONインポート</button><button onClick={() => setMessage("返金処理は責任者操作です")}>返金</button><button onClick={() => setMessage("再印刷処理は責任者操作です")}>再印刷</button><button onClick={() => setShowBusinessMenu(false)}>閉じる</button></div></div>}
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者コード入力後、【サインオン】をタッチ</p><input placeholder="責任者No." /><p>・責任者コードを訂正する場合は【C】を押してください。<br />・2人制の操作を行う場合は【2人制】を押してください。</p><button onClick={() => setShowSignIn(false)}>サインオン</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />身分証を目視し、{ageRequirement(ageProduct)}歳以上であることを確認してください。</p><div className="age-cutoff">今日{ageRequirement(ageProduct)}歳になる生年月日<br /><strong>西暦 {formatDateJa(twentiethBirthday)}</strong><br /><strong>和暦 {formatDateWareki(twentiethBirthday)}</strong><br /><small>この日以前の生年月日なら{ageRequirement(ageProduct)}歳以上です</small></div><button onClick={confirmAge}>確認済み・登録</button><button onClick={() => setAgeProduct(null)}>確認できない</button><small>確認方式: 容貌確認または身分証目視。生年月日・身分証情報は保存しません。</small></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
