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
};
export type ProductLookupResult = {
  code: string;
  codeKind: string;
  existingProducts: Array<{ productCode: string; name: string; priceInclTax: number }>;
  candidates: ProductLookupCandidate[];
  searchedAt: string;
};
