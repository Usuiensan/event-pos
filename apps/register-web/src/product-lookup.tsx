import { useEffect, useMemo, useState } from "react";
import type { ProductLookupCandidate, ProductLookupResult } from "@event-pos/contracts";
import { checkoutApi } from "./checkout-api.js";
import { buildProductNameCandidates } from "./admin-settings.js";

type Field = "name" | "seller" | "manufacturer" | "brand" | "producer" | "specification";
type Settings = { spacing: "half" | "none"; katakana: "full" | "half" };

const clean = (value: string) => value.replace(/<[^>]*>/g, " ").replace(/&(?:lt|gt|amp|quot|nbsp);/gi, " ").replace(/https?:\/\/\S+/gi, " ").replace(/\b(?:JAN|ISBN|商品コード)\s*[:：]?\s*\d{8,18}\b/gi, " ").replace(/(?:通販|Yahoo!ショッピング|楽天市場|Amazon|ストア|ショップ|店|ポイント|送料無料|爆買|LINEアカウント連携|ランキングや口コミも豊富|東京倉庫|お買上げの場合は.*?別送).*$/gi, " ").replace(/\s+/g, " ").trim();
const splitWords = (value: string) => clean(value).replace(/[（(［\[【「『〈《]/g, " ").replace(/[）)］\]】」』〉》]/g, " ").replace(/[：:｜|／/\\,，、;；・]+/g, " ").replace(/([A-Za-z]+)(?=[ぁ-んァ-ヶ一-龠])/g, "$1 ").replace(/([ぁ-んァ-ヶ一-龠])(?=[A-Za-z0-9])/g, "$1 ").replace(/([A-Za-z])(?=\d)/g, "$1 ").replace(/(\d)(?=[A-Za-z])/g, "$1 ").split(/\s+/).filter((part) => part && !/^\d{8,18}$/.test(part));
const fullKatakana = "ァアィイゥウェエォオカガキギクグケゲコゴサザシジスズセゼソゾタダチヂッツヅテデトドナニヌネノハバパヒビピフブプヘベペホボポマミムメモャヤュユョヨラリルレロワヲンヴヵヶ";
const halfKatakana = ["ｧ", "ｱ", "ｨ", "ｲ", "ｩ", "ｳ", "ｪ", "ｴ", "ｫ", "ｵ", "ｶ", "ｶﾞ", "ｷ", "ｷﾞ", "ｸ", "ｸﾞ", "ｹ", "ｹﾞ", "ｺ", "ｺﾞ", "ｻ", "ｻﾞ", "ｼ", "ｼﾞ", "ｽ", "ｽﾞ", "ｾ", "ｾﾞ", "ｿ", "ｿﾞ", "ﾀ", "ﾀﾞ", "ﾁ", "ﾁﾞ", "ｯ", "ﾂ", "ﾂﾞ", "ﾃ", "ﾃﾞ", "ﾄ", "ﾄﾞ", "ﾅ", "ﾆ", "ﾇ", "ﾈ", "ﾉ", "ﾊ", "ﾊﾞ", "ﾊﾟ", "ﾋ", "ﾋﾞ", "ﾋﾟ", "ﾌ", "ﾌﾞ", "ﾌﾟ", "ﾍ", "ﾍﾞ", "ﾍﾟ", "ﾎ", "ﾎﾞ", "ﾎﾟ", "ﾏ", "ﾐ", "ﾑ", "ﾒ", "ﾓ", "ｬ", "ﾔ", "ｭ", "ﾕ", "ｮ", "ﾖ", "ﾗ", "ﾘ", "ﾙ", "ﾚ", "ﾛ", "ﾜ", "ｦ", "ﾝ", "ｳﾞ", "ﾜﾞ", "ｦﾞ"];
const toHalfKatakana = (value: string) => Array.from(value.normalize("NFC")).map((char) => { const index = fullKatakana.indexOf(char); return index >= 0 ? halfKatakana[index] ?? char : char; }).join("");
const normalizeWord = (value: string, katakana: Settings["katakana"]) => katakana === "full" ? value.normalize("NFKC") : toHalfKatakana(value);
const formatName = (words: string[], settings: Settings) => words.map((word) => normalizeWord(word, settings.katakana)).join(settings.spacing === "half" ? " " : "");
const displayWidth = (value: string) => Array.from(value).reduce((sum, char) => sum + (/^[\x00-\xff]$/.test(char) ? 1 : 2), 0);

export function ProductLookup({ eventId, code, disabled, onApply }: { eventId: string; code: string; disabled: boolean; onApply: (candidate: ProductLookupCandidate, field: Field) => void }) {
  const [result, setResult] = useState<ProductLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedName, setSelectedName] = useState(0);
  const [words, setWords] = useState<string[]>([]);
  const [removedWords, setRemovedWords] = useState<string[]>([]);
  const [dragged, setDragged] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings>({ spacing: "none", katakana: "half" });
  const names = useMemo(() => result ? buildProductNameCandidates(result.candidates, code) : [], [result, code]);
  const sourceWords = useMemo(() => result?.candidates.map((candidate, index) => ({ id: `${candidate.source}-${candidate.url ?? index}`, source: candidate.source, words: splitWords(candidate.name ?? "") })) ?? [], [result]);

  useEffect(() => { setWords(splitWords(names[selectedName] ?? "")); setRemovedWords([]); }, [names, selectedName]);
  const lookup = async () => { setLoading(true); setError(""); try { setResult(await checkoutApi.lookupProduct(eventId, code)); } catch (cause) { setResult(null); setError(cause instanceof Error ? cause.message : "候補を取得できません"); } finally { setLoading(false); } };
  const adopt = (candidate: ProductLookupCandidate, field: Field) => { void checkoutApi.recordProductLookupAdoption(eventId, code, field, candidate).catch(() => undefined); onApply(candidate, field); };
  const manualName = formatName(words, settings);
  const addWord = (word: string) => setWords((current) => current.includes(word) ? current : [...current, word]);
  const removeWord = (index: number) => { const word = words[index]; if (!word) return; setWords((current) => current.filter((_, i) => i !== index)); setRemovedWords((current) => current.includes(word) ? current : [...current, word]); };
  const restoreWord = (word: string) => { setRemovedWords((current) => current.filter((item) => item !== word)); addWord(word); };
  const moveWord = (from: number, to: number) => setWords((current) => { const next = [...current]; if (from < 0 || to < 0 || from >= next.length || to >= next.length) return current; [next[from], next[to]] = [next[to]!, next[from]!]; return next; });
  const nameCandidate = (name: string): ProductLookupCandidate => ({ name, source: "候補名整理", strength: "medium", reason: "サイト別単語チップの手動調整" });

  return <div className="product-lookup">
    <button type="button" disabled={disabled || loading || !/^\d{8,18}$/.test(code)} onClick={() => void lookup()}>{loading ? "候補を検索中…" : "候補をネット検索"}</button>
    {error && <small className="product-lookup-error">{error}</small>}
    {result && <div className="product-lookup-result">
      <small>コード種別: {result.codeKind} ／ 候補は未確定です</small>
      {result.existingProducts.map((item) => <div className="product-lookup-existing" key={item.productCode}>既存商品: {item.name}（{item.priceInclTax.toLocaleString()}円）</div>)}
      <div className="product-name-builder">
        <strong>おすすめ商品名</strong><small>JANは商品名に含めません。候補は選択後に手動調整できます。</small>
        <select aria-label="商品名候補" value={selectedName} onChange={(event) => setSelectedName(Number(event.target.value))}>{names.map((name, index) => <option key={name} value={index}>{name}</option>)}</select>
        <button type="button" disabled={disabled || !names[selectedName]} onClick={() => adopt(nameCandidate(names[selectedName]!), "name")}>おすすめを採用</button>
        <strong>表記設定</strong>
        <div className="product-name-options"><label>カタカナ<select value={settings.katakana} onChange={(event) => setSettings((current) => ({ ...current, katakana: event.target.value as Settings["katakana"] }))}><option value="half">半角</option><option value="full">全角</option></select></label><label>単語間<select value={settings.spacing} onChange={(event) => setSettings((current) => ({ ...current, spacing: event.target.value as Settings["spacing"] }))}><option value="none">スペースなし</option><option value="half">半角スペース</option></select></label></div>
        <strong>手動調整</strong><small>各サイトの単語横の＋で追加、チップはドラッグで並べ替え、×で削除できます。</small>
        <div className="product-name-chips">{words.map((word, index) => <span className="product-name-chip" draggable onDragStart={() => setDragged(index)} onDragOver={(event) => event.preventDefault()} onDrop={() => { if (dragged !== null) moveWord(dragged, index); setDragged(null); }} key={`${word}-${index}`}>{normalizeWord(word, settings.katakana)}<button type="button" onClick={() => removeWord(index)}>×</button></span>)}</div>
        {removedWords.length > 0 && <div className="product-name-removed"><small>削除した単語（クリックで復活）</small>{removedWords.map((word) => <button type="button" key={word} onClick={() => restoreWord(word)}>＋ {normalizeWord(word, settings.katakana)}</button>)}</div>}
        <output className={displayWidth(manualName) > 32 ? "product-name-warning" : ""}>{manualName || "チップを選択してください"}（{displayWidth(manualName)}/32幅）</output>
        <button type="button" disabled={disabled || !manualName} onClick={() => adopt(nameCandidate(manualName), "name")}>手動調整した商品名を採用</button>
      </div>
      <div className="product-source-words"><strong>サイト別の単語</strong>{sourceWords.map((item) => <div className="product-source-words-row" key={item.id}><small>{item.source}</small><div>{item.words.map((word, index) => <button type="button" className="product-source-word" disabled={disabled || words.includes(word)} onClick={() => addWord(word)} key={`${item.id}-${word}-${index}`}>＋ {normalizeWord(word, settings.katakana)}</button>)}</div></div>)}</div>
      {result.candidates.map((candidate, index) => <article key={`${candidate.source}-${candidate.url ?? index}`}><div><strong>{clean(candidate.name ?? candidate.company ?? "事業者情報")}</strong><small>{candidate.source} ／ {candidate.reason}</small></div><div className="product-lookup-actions">{candidate.company && <><button type="button" disabled={disabled} onClick={() => adopt(candidate, "manufacturer")}>メーカー</button><button type="button" disabled={disabled} onClick={() => adopt(candidate, "brand")}>ブランド</button><button type="button" disabled={disabled} onClick={() => adopt(candidate, "seller")}>販売者</button><button type="button" disabled={disabled} onClick={() => adopt(candidate, "producer")}>製造者</button></>}{candidate.name && <button type="button" disabled={disabled} onClick={() => adopt(candidate, "specification")}>規格</button>}{candidate.url && <a href={candidate.url} target="_blank" rel="noreferrer">根拠を開く</a>}</div></article>)}
    </div>}
  </div>;
}
