import { StrictMode, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { exportEventCatalog, importEventCatalog, formatJapaneseYenSpeech, type EventCatalog, type ProductDefinition, type QuickEntry } from "@event-pos/contracts";
import { createSpeechPlayer, speakChangeReady, speakProductPrice, speakReceiptReady, speakSubtotal, type SpeechPlayer } from "./speech.js";
import "./styles.css";

const initialCatalog: EventCatalog = { eventId: "demo-event", products: [
  { productCode: "A001", name: "新刊", priceInclTax: 500, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO001" },
  { productCode: "A002", name: "既刊", priceInclTax: 1000, taxRate: 10, saleState: "on_sale", internalToken: "P1DEMO002" },
], quickEntries: [{ id: "set-1", label: "新刊2冊セット", components: [{ productCode: "A001", quantity: 2 }] }] };

function App() {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cart, setCart] = useState<Array<{ product: ProductDefinition; quantity: number }>>([]);
  const [message, setMessage] = useState("会計待ち");
  const speech = useMemo<SpeechPlayer>(() => createSpeechPlayer(), []);
  const fileRef = useRef<HTMLInputElement>(null);
  const total = cart.reduce((sum, line) => sum + line.product.priceInclTax * line.quantity, 0);
  const addProduct = (product: ProductDefinition, quantity = 1) => {
    if (product.saleState !== "on_sale") return setMessage("販売停止中の商品です");
    setCart((current) => [...current, { product, quantity }]);
    speakProductPrice(speech, formatJapaneseYenSpeech(product.priceInclTax));
    setMessage(`${product.name}を登録しました`);
  };
  const addQuick = (quick: QuickEntry) => {
    if (quick.productCode) { const p = catalog.products.find((item) => item.productCode === quick.productCode); if (p) addProduct(p, quick.quantity ?? 1); return; }
    for (const component of quick.components ?? []) { const p = catalog.products.find((item) => item.productCode === component.productCode); if (p) addProduct(p, component.quantity); }
  };
  const importJson = (text: string) => { try { setCatalog(importEventCatalog(text)); setCart([]); setMessage("商品JSONを読み込みました"); } catch (error) { setMessage(error instanceof Error ? error.message : "JSONが不正です"); } };
  return <main className="register-shell">
    <header><p className="eyebrow">event-pos / {catalog.eventId}</p><h1>{message}</h1></header>
    <section className="toolbar"><button onClick={() => fileRef.current?.click()}>JSONインポート</button><input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => { const file = event.target.files?.[0]; if (file) file.text().then(importJson); }} /><button onClick={() => { const blob = new Blob([exportEventCatalog(catalog)], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `${catalog.eventId}-catalog.json`; a.click(); URL.revokeObjectURL(url); }}>JSONエクスポート</button></section>
    <section className="product-grid"><h2>商品</h2>{catalog.products.map((product) => <button key={product.productCode} disabled={product.saleState !== "on_sale"} onClick={() => addProduct(product)}><strong>{product.name}</strong><span>{product.priceInclTax.toLocaleString()}円</span><small>{product.productCode}</small></button>)}<h2>ワンタップ</h2>{catalog.quickEntries.map((quick) => <button key={quick.id} className="quick" onClick={() => addQuick(quick)}><strong>{quick.label}</strong><small>{quick.id}</small></button>)}</section>
    <section className="cart"><h2>明細</h2>{cart.length === 0 ? <p>商品を登録してください。</p> : cart.map((line, index) => <p key={`${line.product.productCode}-${index}`}>{line.product.name} × {line.quantity} <b>{(line.product.priceInclTax * line.quantity).toLocaleString()}円</b></p>)}<h2>合計 {total.toLocaleString()}円</h2><button onClick={() => { speakSubtotal(speech, `合計金額は${formatJapaneseYenSpeech(total)}`); setMessage(`合計金額は${total.toLocaleString()}円です`); }}>小計</button><button onClick={() => { speakReceiptReady(speech); setMessage("レシートをお受け取りください"); }}>レシート発行</button><button onClick={() => { speakChangeReady(speech); setMessage("おつりをおたしかめください"); }}>釣銭確認</button></section>
  </main>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
