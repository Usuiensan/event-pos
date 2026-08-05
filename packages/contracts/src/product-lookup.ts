export type ProductLookupEvidenceStrength = "strong" | "medium" | "weak";
export type ProductLookupCandidate = {
  name?: string;
  author?: string;
  company?: string;
  price?: number;
  url?: string;
  source: string;
  strength: ProductLookupEvidenceStrength;
  reason: string;
  /** 同一要素が候補サイト間で確認された回数。 */
  agreement?: number;
};
export type ProductLookupResult = {
  code: string;
  codeKind: string;
  existingProducts: Array<{ productCode: string; name: string; priceInclTax: number }>;
  candidates: ProductLookupCandidate[];
  searchedAt: string;
  excludedTokens?: string[];
};
