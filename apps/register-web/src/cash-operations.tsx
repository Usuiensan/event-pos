import { useEffect, useMemo, useState } from "react";
import { cashDenominations, calculateCashActual, type CashCount, type CashDenomination } from "@event-pos/contracts";
import { checkoutApi, type BackupArtifactDto, type CashSessionDto, type CashSettlementSummary } from "./checkout-api.js";

type CheckKind = "opening" | "interim" | "closing";
type PendingAction =
  | { kind: "check"; checkKind: CheckKind; counted: CashCount[]; carryoverYen?: number }
  | { kind: "movement"; movementType: "pay_in" | "pay_out"; amountYen: number; reason: string }
  | { kind: "reopen"; reason: string };

const labels = { opening: "営業開始", interim: "中間点検", closing: "精算" } as const;
const movementLabels = { pay_in: "入金", pay_out: "出金" } as const;
const yen = (value: number) => `${value.toLocaleString("ja-JP")}円`;

export function CashOperations({ eventId, businessSessionId, businessDate, cashboxId, actorId, terminalId, onClose, onArtifact }: { eventId: string; businessSessionId: string; businessDate: string; cashboxId: string; actorId: string; terminalId: string; onClose: () => void; onArtifact?: (artifact: BackupArtifactDto) => void }) {
  const [session, setSession] = useState<CashSessionDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [checkKind, setCheckKind] = useState<CheckKind | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [carryover, setCarryover] = useState("");
  const [movementType, setMovementType] = useState<"pay_in" | "pay_out" | null>(null);
  const [movementAmount, setMovementAmount] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [lastArtifact, setLastArtifact] = useState<BackupArtifactDto | null>(null);
  const [settlementSummary, setSettlementSummary] = useState<CashSettlementSummary | null>(null);

  const refresh = async () => {
    const result = await checkoutApi.getCurrentCashSession(eventId, businessDate, cashboxId, actorId);
    setSession(result.session); setError("");
  };
  useEffect(() => { let active = true; void refresh().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "現金セッションを取得できません"); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [eventId, businessDate, cashboxId, actorId]);

  const counted = useMemo(() => cashDenominations.map((denomination) => ({ denomination, quantity: Number(counts[denomination] || 0) })).filter((item) => item.quantity > 0), [counts]);
  const countedYen = useMemo(() => calculateCashActual(counted), [counted]);
  const theoreticalYen = session?.theoreticalYen ?? 0;
  const differenceYen = countedYen - theoreticalYen;

  const beginCheck = (kind: CheckKind) => { setCheckKind(kind); setMovementType(null); setReason(""); setCounts({}); setCarryover(""); setPending(null); };
  const prepareCheck = () => {
    if (!checkKind) return;
    const nextCarryover = checkKind === "closing" ? Number(carryover) : undefined;
    if (counted.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity < 0)) return setError("金種枚数は0以上の整数で入力してください");
    if (checkKind === "closing" && (!Number.isSafeInteger(nextCarryover) || nextCarryover! < 0 || nextCarryover! > countedYen)) return setError("翌日残しは実在高以下の整数円で入力してください");
    setError(""); setPending({ kind: "check", checkKind, counted, ...(nextCarryover === undefined ? {} : { carryoverYen: nextCarryover }) });
  };
  const prepareMovement = () => {
    if (!movementType) return;
    const amountYen = Number(movementAmount);
    if (!Number.isSafeInteger(amountYen) || amountYen <= 0) return setError("金額は1円以上の整数で入力してください");
    if (!reason.trim()) return setError(`${movementLabels[movementType]}理由を入力してください`);
    setError(""); setPending({ kind: "movement", movementType, amountYen, reason: reason.trim() });
  };
  const execute = async () => {
    if (!pending || submitting) return;
    setSubmitting(true); setError("");
    try {
      if (pending.kind === "check") {
        let current = session;
        if (!current) {
          await checkoutApi.prepareRegister(businessSessionId, cashboxId, terminalId);
          const refreshed = await checkoutApi.getCurrentCashSession(eventId, businessDate, cashboxId, actorId);
          current = refreshed.session;
        }
        if (!current) throw new Error("レジの準備を開始できませんでした");
        const storageKey = `event-pos-cash-check-${current.sessionId}-${pending.checkKind}`;
        const idempotencyKey = localStorage.getItem(storageKey) ?? crypto.randomUUID(); localStorage.setItem(storageKey, idempotencyKey);
        const result = await checkoutApi.saveCashCheck(current.sessionId, pending.checkKind, { counted: pending.counted, ...(pending.carryoverYen === undefined ? {} : { carryoverYen: pending.carryoverYen }), terminalId }, actorId, idempotencyKey);
        localStorage.removeItem(storageKey);
        if (result.backupArtifact) { setLastArtifact(result.backupArtifact); onArtifact?.(result.backupArtifact); }
        if (pending.checkKind !== "opening") setSettlementSummary(await checkoutApi.getCashSettlementSummary(current.sessionId));
      } else if (pending.kind === "movement") {
        if (!session) throw new Error("営業開始後に入出金してください");
        const storageKey = `event-pos-cash-movement-${session.sessionId}`; const idempotencyKey = localStorage.getItem(storageKey) ?? crypto.randomUUID(); localStorage.setItem(storageKey, idempotencyKey);
        await checkoutApi.saveCashMovement(session.sessionId, { type: pending.movementType, amountYen: pending.amountYen, reason: pending.reason, idempotencyKey, terminalId }, actorId); localStorage.removeItem(storageKey);
      } else {
        if (!session) throw new Error("現金セッションがありません");
        await checkoutApi.reopenCashSession(session.sessionId, pending.reason, terminalId, actorId);
      }
      await refresh(); setPending(null); setCheckKind(null); setMovementType(null); setMovementAmount(""); setReason(""); setCounts({}); setCarryover("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "現金操作に失敗しました"); }
    finally { setSubmitting(false); }
  };

  const latestCheck = session?.checks[0];
  return <div className="modal-backdrop cash-operations-layer"><section className="cash-operations" aria-label="現金管理"><header><div><h2>現金管理</h2><p>{eventId}／{businessDate}／{cashboxId}</p></div><button type="button" onClick={onClose}>閉じる</button></header>
    {loading ? <p>現金セッションを確認しています…</p> : <>
      <div className="cash-summary"><div><span>状態</span><strong>{!session ? "未開局" : session.state === "closed" ? "精算済み" : session.openingYen === null ? "準備金未登録" : "営業中"}</strong></div><div><span>理論現金</span><strong>{yen(theoreticalYen)}</strong></div><div><span>直近過不足</span><strong className={(latestCheck?.differenceYen ?? 0) === 0 ? "cash-ok" : "cash-warning"}>{latestCheck ? yen(latestCheck.differenceYen) : "—"}</strong></div></div>
      {lastArtifact && <div className="cash-artifact-result"><strong>成果物: {lastArtifact.state === "completed" ? "成功" : lastArtifact.state === "failed" ? "失敗" : "生成待ち"}</strong><span>成果物ID {lastArtifact.artifactId}</span></div>}
      {settlementSummary && <section className="cash-settlement-summary" aria-label="中間計・精算集計"><h3>中間計・精算集計</h3><p>取引 {settlementSummary.salesCount}件／売上 {yen(settlementSummary.salesYen)}</p><SummaryRows title="商品別" rows={settlementSummary.products.map((row) => `${row.name} ×${row.quantity}　${yen(row.salesYen)}`)} /><SummaryRows title="担当者別" rows={settlementSummary.staff.map((row) => `${row.staffId} ${row.salesCount}件　${yen(row.salesYen)}`)} /><SummaryRows title="決済手段別" rows={settlementSummary.payments.map((row) => `${row.methodName} ${row.salesCount}件　${yen(row.salesYen)}`)} /><SummaryRows title="時間帯別（JST）" rows={settlementSummary.timeBands.map((row) => `${row.timeBand} ${row.salesCount}件　${yen(row.salesYen)}`)} /></section>}
      {!checkKind && !movementType && <div className="cash-actions">
        {(!session || session.openingYen === null) && <button onClick={() => beginCheck("opening")}>営業開始・準備金入力</button>}
        {session?.state === "open" && session.openingYen !== null && <><button onClick={() => setMovementType("pay_in")}>入金</button><button onClick={() => setMovementType("pay_out")}>出金</button><button onClick={() => beginCheck("interim")}>中間点検</button><button className="cash-danger" onClick={() => beginCheck("closing")}>精算</button></>}
        {session?.state === "closed" && <button className="cash-danger" onClick={() => { setReason(""); setPending(null); }}>精算を再開する</button>}
      </div>}
      {session?.state === "closed" && !checkKind && !movementType && !pending && <div className="cash-reopen"><label>再開理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><button disabled={!reason.trim()} onClick={() => setPending({ kind: "reopen", reason: reason.trim() })}>責任者として再開確認へ</button></div>}
      {checkKind && <div className="cash-count-form"><h3>{labels[checkKind]} — 金種別実査</h3><div className="denomination-grid">{cashDenominations.slice().reverse().map((denomination) => <label key={denomination}><span>{denomination.toLocaleString("ja-JP")}円</span><input aria-label={`${denomination}円の枚数`} inputMode="numeric" value={counts[denomination] ?? ""} onChange={(event) => setCounts((current) => ({ ...current, [denomination]: event.target.value.replace(/\D/g, "").slice(0, 6) }))} /><small>{yen(denomination * Number(counts[denomination] || 0))}</small></label>)}</div><div className="cash-check-preview"><span>理論現金 {yen(theoreticalYen)}</span><span>実在高 {yen(countedYen)}</span><strong>過不足 {yen(differenceYen)}</strong></div>{checkKind === "closing" && <label>翌日残し（円）<input aria-label="翌日残し" inputMode="numeric" value={carryover} onChange={(event) => setCarryover(event.target.value.replace(/\D/g, "").slice(0, 9))} /></label>}<div><button onClick={prepareCheck}>確認へ</button><button onClick={() => setCheckKind(null)}>戻る</button></div></div>}
      {movementType && <div className="cash-movement-form"><h3>{movementLabels[movementType]}</h3><label>金額（円）<input aria-label={`${movementLabels[movementType]}金額`} inputMode="numeric" value={movementAmount} onChange={(event) => setMovementAmount(event.target.value.replace(/\D/g, "").slice(0, 9))} /></label><label>理由<textarea value={reason} onChange={(event) => setReason(event.target.value)} /></label><div><button onClick={prepareMovement}>確認へ</button><button onClick={() => setMovementType(null)}>戻る</button></div></div>}
      {pending && <div className="cash-confirm" role="dialog" aria-label="現金操作の確認"><h3>操作前確認</h3><dl><dt>操作</dt><dd>{pending.kind === "check" ? labels[pending.checkKind] : pending.kind === "movement" ? movementLabels[pending.movementType] : "精算の再開"}</dd><dt>責任者</dt><dd>{actorId}</dd><dt>営業日</dt><dd>{businessDate}</dd>{pending.kind === "check" && <><dt>理論現金</dt><dd>{yen(theoreticalYen)}</dd><dt>実在高</dt><dd>{yen(calculateCashActual(pending.counted))}</dd><dt>過不足</dt><dd>{yen(calculateCashActual(pending.counted) - theoreticalYen)}</dd>{pending.carryoverYen !== undefined && <><dt>翌日残し</dt><dd>{yen(pending.carryoverYen)}</dd></>}</>}{pending.kind === "movement" && <><dt>金額</dt><dd>{yen(pending.amountYen)}</dd><dt>理由</dt><dd>{pending.reason}</dd></>}{pending.kind === "reopen" && <><dt>理由</dt><dd>{pending.reason}</dd></>}</dl><p>この操作は監査ログへ記録されます。</p><div><button className="cash-danger" disabled={submitting} onClick={() => void execute()}>{submitting ? "確定中…" : "確定する"}</button><button disabled={submitting} onClick={() => setPending(null)}>戻る</button></div></div>}
      {error && <p className="cash-operation-error" role="alert">{error}</p>}
    </>}
  </section></div>;
}

function SummaryRows({ title, rows }: { title: string; rows: string[] }) { return <div className="cash-summary-group"><h4>{title}</h4>{rows.length ? <ul>{rows.map((row) => <li key={row}>{row}</li>)}</ul> : <p>該当なし</p>}</div>; }
