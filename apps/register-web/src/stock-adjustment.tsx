import { useEffect, useState } from "react";
import { checkoutApi, type InventoryProductDto } from "./checkout-api.js";

export function StockAdjustment({ eventId, products, onClose }: { eventId: string; products: Array<{ productCode: string; name: string }>; onClose: () => void }) {
  const [inventory, setInventory] = useState<InventoryProductDto[]>([]);
  const [selected, setSelected] = useState("");
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { setBusy(true); void checkoutApi.getInventory(eventId).then((result) => setInventory(result.products)).catch((cause) => setError(cause instanceof Error ? cause.message : "在庫を取得できません")).finally(() => setBusy(false)); }, [eventId]);
  const nameOf = (productCode: string) => products.find((product) => product.productCode === productCode)?.name ?? productCode;
  const current = inventory.find((item) => item.productCode === selected);
  const targetValue = Number(target);
  const targetValid = target.trim() !== "" && Number.isSafeInteger(targetValue) && targetValue >= 0;
  const submit = async () => { if (!current?.tracked || !targetValid || !reason.trim()) return; setBusy(true); try { const updated = await checkoutApi.adjustInventory(eventId, current.productCode, targetValue, reason.trim()); setInventory((items) => items.map((item) => item.productCode === updated.productCode ? updated : item)); setMessage(`${nameOf(updated.productCode)} の在庫を ${updated.remaining} に調整しました`); setTarget(""); setReason(""); setError(""); } catch (cause) { setError(cause instanceof Error ? cause.message : "在庫調整に失敗しました"); } finally { setBusy(false); } };
  return <div className="modal-backdrop"><section className="return-operations"><header><div><h2>在庫調整</h2><p>現在の在庫数を目標数に合わせ、理由とともに監査へ記録します。</p></div><button onClick={onClose}>閉じる</button></header><div className="return-results">{inventory.map((item) => <button key={item.productCode} disabled={busy || !item.tracked} className={selected === item.productCode ? "selected-line" : ""} onClick={() => { setSelected(item.productCode); setMessage(""); }}><span>{nameOf(item.productCode)}</span>{item.tracked ? <span>現在庫 {item.remaining}／販売可能 {item.available}</span> : <span>在庫管理なし</span>}<small>{item.productCode}</small></button>)}</div>{current?.tracked && <div className="return-confirm"><h3>{nameOf(current.productCode)}</h3><p>現在庫 {current.remaining}（販売可能 {current.available}）</p><label>調整後の在庫数<input type="number" min="0" step="1" value={target} onChange={(event) => setTarget(event.target.value)} /></label><label>調整理由<input value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={busy || !targetValid || !reason.trim()} onClick={() => void submit()}>在庫を調整する</button></div>}{message && <p>{message}</p>}{error && <p role="alert" className="return-error">{error}</p>}</section></div>;
}
