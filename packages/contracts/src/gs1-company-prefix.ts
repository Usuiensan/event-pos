/** GS1 Japanから取得した許諾済み事業者コード台帳の1行。 */
export type Gs1CompanyPrefixRecord = {
  /** 4〜12桁のGS1事業者コード（チェックデジットを含めない）。 */
  prefix: string;
  companyName: string;
  companyNameKana?: string;
  gln?: string;
  source: string;
  lastVerifiedAt?: string;
};

export type Gs1CompanyPrefixRegistry = {
  schemaVersion: 1;
  country: "JP";
  source: string;
  sourceUrl: string;
  lastVerifiedAt?: string;
  records: Gs1CompanyPrefixRecord[];
};

export type Gs1ProductCodeInfo = {
  codeType: "upc-a" | "ean-13";
  gs1Prefix?: string;
  companyName?: string;
  companyNameKana?: string;
  gln?: string;
  source?: string;
  lastVerifiedAt?: string;
};

export function lookupGs1Company(registry: Pick<Gs1CompanyPrefixRegistry, "records"> | undefined, code: string): Gs1CompanyPrefixRecord | undefined {
  if (!/^\d+$/.test(code) || (code.length !== 12 && code.length !== 13)) return undefined;
  const ean13 = code.length === 12 ? `0${code}` : code;
  const body = ean13.slice(0, -1);
  return registry?.records
    .filter((record) => body.startsWith(record.prefix))
    .sort((left, right) => right.prefix.length - left.prefix.length)[0];
}

export function gs1ProductCodeInfo(registry: Pick<Gs1CompanyPrefixRegistry, "records"> | undefined, code: string): Gs1ProductCodeInfo | undefined {
  if (!/^\d+$/.test(code) || (code.length !== 12 && code.length !== 13)) return undefined;
  const record = lookupGs1Company(registry, code);
  return {
    codeType: code.length === 12 ? "upc-a" : "ean-13",
    ...(record ? { gs1Prefix: record.prefix, companyName: record.companyName, ...(record.companyNameKana ? { companyNameKana: record.companyNameKana } : {}), ...(record.gln ? { gln: record.gln } : {}), source: record.source, ...(record.lastVerifiedAt ? { lastVerifiedAt: record.lastVerifiedAt } : {}) } : {}),
  };
}

export function validateGs1CompanyPrefixRegistry(input: unknown): Gs1CompanyPrefixRegistry {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("GS1事業者コード台帳はオブジェクトで指定してください");
  const value = input as Partial<Gs1CompanyPrefixRegistry>;
  if (value.schemaVersion !== 1 || value.country !== "JP" || typeof value.source !== "string" || typeof value.sourceUrl !== "string" || !Array.isArray(value.records)) throw new Error("GS1事業者コード台帳のメタデータが不正です");
  const records = value.records.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`GS1事業者コード台帳 records[${index}]が不正です`);
    const record = raw as Partial<Gs1CompanyPrefixRecord>;
    if (typeof record.prefix !== "string" || !/^\d{4,12}$/.test(record.prefix) || typeof record.companyName !== "string" || !record.companyName.trim() || typeof record.source !== "string" || !record.source.trim()) throw new Error(`GS1事業者コード台帳 records[${index}]のprefix/companyName/sourceが不正です`);
    for (const key of ["companyNameKana", "gln", "lastVerifiedAt"] as const) if (record[key] !== undefined && typeof record[key] !== "string") throw new Error(`GS1事業者コード台帳 records[${index}].${key}が不正です`);
    return { prefix: record.prefix, companyName: record.companyName.trim(), ...(record.companyNameKana ? { companyNameKana: record.companyNameKana.trim() } : {}), ...(record.gln ? { gln: record.gln.trim() } : {}), source: record.source.trim(), ...(record.lastVerifiedAt ? { lastVerifiedAt: record.lastVerifiedAt } : {}) };
  });
  const prefixes = new Set<string>();
  for (const record of records) if (prefixes.has(record.prefix)) throw new Error(`GS1事業者コード台帳のprefixが重複しています: ${record.prefix}`); else prefixes.add(record.prefix);
  return { schemaVersion: 1, country: "JP", source: value.source, sourceUrl: value.sourceUrl, ...(value.lastVerifiedAt ? { lastVerifiedAt: value.lastVerifiedAt } : {}), records };
}
