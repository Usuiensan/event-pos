import { useEffect, useState } from "react";
import { importEventCatalog, type EventCatalog } from "@event-pos/contracts";
import { checkoutApi, type AuthActor } from "./checkout-api.js";

export function AdminSettings({ eventId }: { eventId: string }) {
  const [actor, setActor] = useState<AuthActor | null>(null);
  const [number, setNumber] = useState("");
  const [catalogText, setCatalogText] = useState("");
  const [receiptText, setReceiptText] = useState("");
  const [receiptKey, setReceiptKey] = useState("sale-receipt");
  const [receiptVersion, setReceiptVersion] = useState<number | null>(null);
  const [message, setMessage] = useState("管理者または責任者としてサインオンしてください。");
  const [businessOpen, setBusinessOpen] = useState(false);
  const load = async () => {
    const result = await checkoutApi.getManagementConfig(eventId);
    setCatalogText(JSON.stringify(result.catalog, null, 2)); setBusinessOpen(result.businessOpen);
    const templates = await checkoutApi.listReceiptTemplates();
    const active = templates.templates.find((template) => template.status === "active") ?? templates.templates[0];
    if (active) { setReceiptKey(active.templateKey); setReceiptText(active.sourceText); setReceiptVersion(active.version); }
  };
  useEffect(() => { void checkoutApi.getAuthSession().then((next) => { if (next.role === "operator") throw new Error("manager以上の権限が必要です"); setActor(next); return load(); }).catch((error) => setMessage(error instanceof Error ? error.message : "サインオンしてください")); }, []);
  const signIn = () => void checkoutApi.signIn(eventId, number, "management-console").then(async (next) => { if (next.role === "operator") throw new Error("この責任者には管理権限がありません"); setActor(next); await load(); setMessage("設定を読み込みました。保存確定まで本番へ反映されません。"); }).catch((error) => setMessage(error instanceof Error ? error.message : "サインオンに失敗しました"));
  const save = () => {
    try {
      const catalog: EventCatalog = importEventCatalog(catalogText);
      void checkoutApi.saveManagementConfig(eventId, catalog).then((result) => { setCatalogText(JSON.stringify(result.catalog, null, 2)); setMessage(`YAMLへ保存しました。Git ${result.gitCommitId ?? "コミット未設定"}`); }).catch((error) => setMessage(error instanceof Error ? error.message : "保存に失敗しました"));
    } catch (error) { setMessage(error instanceof Error ? error.message : "設定JSONが不正です"); }
  };
  const createReceiptDraft = () => void checkoutApi.createReceiptTemplate(receiptKey, receiptText).then((template) => { setReceiptVersion(template.version); setMessage(`レシート下書き v${template.version} を作成しました。`); }).catch((error) => setMessage(error instanceof Error ? error.message : "下書き作成に失敗しました"));
  const validatePreview = () => { if (!receiptVersion) return; void checkoutApi.validateReceiptTemplate(receiptKey, receiptVersion).then((result) => checkoutApi.previewReceiptTemplate(receiptKey, receiptVersion).then((preview) => setMessage(`検証済み: ${result.sourceSha256}\n${preview.humanReadable}\n${preview.warnings.join("\n")}`))).catch((error) => setMessage(error instanceof Error ? error.message : "検証に失敗しました")); };
  const activate = () => { if (!receiptVersion) return; void checkoutApi.validateReceiptTemplate(receiptKey, receiptVersion).then((result) => checkoutApi.activateReceiptTemplate(receiptKey, receiptVersion!, result.sourceSha256)).then(() => setMessage(`レシート ${receiptKey} v${receiptVersion} を有効化しました。`)).catch((error) => setMessage(error instanceof Error ? error.message : "有効化に失敗しました")); };
  if (!actor) return <main className="admin-console"><h1>POS管理画面</h1><p>{message}</p><label>3桁責任者番号<input value={number} inputMode="numeric" maxLength={3} onChange={(event) => setNumber(event.target.value.replace(/\D/g, "").slice(0, 3))} /></label><button onClick={signIn}>サインオン</button></main>;
  return <main className="admin-console"><header><h1>POS管理画面</h1><p>{actor.displayName}（{actor.role}）／{businessOpen ? "営業中: 下書きのみ" : "未開局: 保存可能"}</p></header><p className="admin-message">{message}</p><section><h2>イベント・商品・スタッフ・画面・割引・顧客表示</h2><p>全マスタをJSON形式で編集します。保存時に分割YAMLへ変換し、参照整合性を検証します。</p><textarea aria-label="POS設定JSON" value={catalogText} onChange={(event) => setCatalogText(event.target.value)} rows={28} /><button disabled={businessOpen} onClick={save}>YAMLへ保存確定</button></section><section><h2>レシートフォーマット</h2><label>テンプレートキー<input value={receiptKey} onChange={(event) => setReceiptKey(event.target.value)} /></label><textarea aria-label="レシートテンプレート" value={receiptText} onChange={(event) => setReceiptText(event.target.value)} rows={18} /><div><button disabled={businessOpen} onClick={createReceiptDraft}>下書きを作成</button><button onClick={validatePreview} disabled={!receiptVersion}>検証・プレビュー</button><button disabled={businessOpen || !receiptVersion} onClick={activate}>有効化</button></div></section><button onClick={() => void checkoutApi.signOut().then(() => location.assign("/"))}>サインオフ</button></main>;
}
