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
  const [panel, setPanel] = useState<"detail" | "products">("detail");
  const [showSignIn, setShowSignIn] = useState(true);
  const [showPayment, setShowPayment] = useState(false);
  const [ageProduct, setAgeProduct] = useState<ProductDefinition | null>(null);
  const [ageVerified, setAgeVerified] = useState(false);
  const [received, setReceived] = useState(0);
  const isAgeRestricted = (product: ProductDefinition) => /チューハイ|レモンハイ|獺祭|酒|ビール/.test(product.name);
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer({ speakerId }), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = cart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0);
  useEffect(() => {
    const sync = () => { try { const saved = JSON.parse(localStorage.getItem("event-pos-cart") ?? "[]") as Array<{ productCode: string; quantity: number }>; setCart(saved.flatMap((item) => { const product = catalog.products.find((candidate) => candidate.productCode === item.productCode); return product ? [{ product, quantity: item.quantity }] : []; })); } catch { /* ignore malformed preview state */ } };
    sync(); window.addEventListener("storage", sync); return () => window.removeEventListener("storage", sync);
  }, [catalog.products]);
  useEffect(() => { if (role === "staff") localStorage.setItem("event-pos-cart", JSON.stringify(cart.map((line) => ({ productCode: line.product.productCode, quantity: line.quantity })))); }, [cart, role]);
  useEffect(() => { fetch(`/api/v1/events/${encodeURIComponent(initialCatalog.eventId)}/catalog`).then(async (response) => response.ok ? (await response.json()).catalog as EventCatalog : initialCatalog).then((loaded) => { setCatalog(loaded); setLoading(false); }).catch(() => { setMessage("カタログを読み込めません。初期値を表示しています"); setLoading(false); }); }, []);
  const saveCatalog = async (next: EventCatalog) => { const response = await fetch(`/api/v1/events/${encodeURIComponent(next.eventId)}/catalog`, { method: "PUT", headers: { "content-type": "application/json" }, body: exportEventCatalog(next) }); if (!response.ok) throw new Error((await response.json()).message ?? "カタログ保存に失敗しました"); setCatalog(next); };
  const addProduct = (product: ProductDefinition, quantity = 1) => {
    if (product.saleState !== "on_sale") return setMessage("販売停止中の商品です");
    if (isAgeRestricted(product) && !ageVerified) return setAgeProduct(product);
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
  const confirmAge = () => { setAgeVerified(true); if (ageProduct) { const product = ageProduct; setAgeProduct(null); addProduct(product); } };
  const importJson = (text: string) => { try { const next = importEventCatalog(text); void saveCatalog(next).then(() => { setCart([]); setMessage("商品JSONを保存しました"); }).catch((error) => setMessage(error instanceof Error ? error.message : "カタログ保存に失敗しました")); } catch (error) { setMessage(error instanceof Error ? error.message : "JSONが不正です"); } };
  if (role === "customer") return <main className="pos-screen customer-screen"><header className="pos-header"><span>登録明細</span><span>お客様画面</span></header><section className="customer-lines">{cart.length === 0 ? <div className="customer-empty">商品を登録してください</div> : cart.map((line, index) => <div className="customer-line" key={`${line.product.productCode}-${index}`}><span>{line.product.name}</span><span>{line.product.priceInclTax.toLocaleString()}円</span><span>{line.quantity}点</span><b>{(line.product.priceInclTax * line.quantity).toLocaleString()}円</b></div>)}</section><footer className="customer-total"><span>合計　{cart.reduce((sum, line) => sum + line.quantity, 0)}点</span><strong>{total.toLocaleString()}円</strong></footer></main>;
  return <main className="pos-screen register-shell">
    <header><p className="eyebrow">event-pos / {catalog.eventId}</p><h1>{loading ? "カタログ読み込み中" : message}</h1></header>
    <section className="toolbar"><button onClick={() => fileRef.current?.click()}>JSONインポート</button><input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) file.text().then(importJson); }} /><label>音声話者<select value={speakerId} onChange={(event) => { const next = Number(event.target.value); setSpeakerId(next); localStorage.setItem("event-pos-speaker", String(next)); speech.setSpeaker(next); }}><option value="1">ずんだもん</option><option value="3">四国めたん</option><option value="8">春日部つむぎ</option><option value="114">あんこもん（つよつよ）</option></select></label></section>
    {panel === "products" ? <section className="product-grid"><h2>商品登録 B</h2>{catalog.products.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} onClick={() => addProduct(product)}><strong>{product.name}</strong><span>{product.priceInclTax.toLocaleString()}円</span><small>{product.productCode}</small></button>)}<h2>ワンタップ</h2>{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><strong>{quick.label}</strong><small>{quick.id}</small></button>)}</section> : <section className="detail-panel"><h2>登録明細 A</h2><div className="detail-head">NO.　属性　商品名　　　　　　　 数量　単価　値引　金額</div>{cart.map((line, index) => <div className={`detail-row ${highlighted === line.product.productCode ? "line-highlight" : ""}`} key={`${line.product.productCode}-${index}`}><span>{index + 1}</span><span>—</span><strong>{line.product.name}</strong><span>{line.quantity}</span><span>{line.product.priceInclTax.toLocaleString()}円</span><span>—</span><b>{(line.product.priceInclTax * line.quantity).toLocaleString()}円</b></div>)}{cart.length === 0 && <div className="empty-detail">登録待ち</div>}</section>}
    <section className="cart"><h2>支払</h2><div className="payment-controls"><label>支払方法<select><option>現金</option><option>外部決済</option><option>併用</option></select></label><label>お預り金<input type="number" min="0" value={received || ""} onChange={(event) => setReceived(Number(event.target.value))} /></label><span>釣銭 {Math.max(0, received - total).toLocaleString()}円</span></div><h2>合計 {total.toLocaleString()}円</h2><button disabled={received < total} onClick={() => { speakSubtotal(speech, `合計金額は ${formatJapaneseYenSpeech(total)}`); setMessage(`合計金額は${total.toLocaleString()}円です`); }}>支払確定</button><button disabled={received < total} onClick={() => { speakReceiptReady(speech); setShowPayment(true); setMessage("レシートをお受け取りください"); }}>レシート発行</button><button onClick={() => { speakChangeReady(speech); setMessage("おつりをおたしかめください"); }}>釣銭確認</button></section>
    <button className="panel-switch" onClick={() => setPanel((current) => current === "detail" ? "products" : "detail")}>{panel === "detail" ? "商品登録 B" : "登録明細 A"}</button>
    {showSignIn && <div className="modal-backdrop"><div className="modal sign-in"><h2>■■ サインオン（責任者入力） ■■</h2><p>責任者コード入力後、【サインオン】をタッチ</p><input placeholder="責任者No." /><p>・責任者コードを訂正する場合は【C】を押してください。<br />・2人制の操作を行う場合は【2人制】を押してください。</p><button onClick={() => setShowSignIn(false)}>サインオン</button></div></div>}
    {showPayment && <div className="modal-backdrop"><div className="modal payment"><h2>■■■ 支払い完了 ■■■</h2><p className="receipt-icon">🧾 🪙</p><p>レシートも忘れずにお受け取りください。</p><div className="payment-line">合計　{cart.length}点　{total.toLocaleString()}円</div><div className="payment-line">お預り　　　　　{total.toLocaleString()}円</div><div className="payment-line change">お釣り　　　　　　 0円</div><button onClick={() => { setShowPayment(false); setCart([]); setMessage("会計待ち"); }}>閉じる</button></div></div>}
    {ageProduct && <div className="modal-backdrop"><div className="modal age-modal"><h2>🔞 年齢確認</h2><p>{ageProduct.name}<br />20歳以上ですか？</p><button onClick={confirmAge}>はい（確認済み）</button><button onClick={() => setAgeProduct(null)}>いいえ</button><small>確認方式: 容貌確認。身分証情報は保存しません。</small></div></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
