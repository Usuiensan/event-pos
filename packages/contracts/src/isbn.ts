/** NDLサーチ OpenSearch から取得したISBN書誌情報。 */
export type IsbnProductInfo = {
  code: string;
  productName: string;
  author?: string;
  publisherName?: string;
  issued?: string;
  price?: number;
  sourceUrl: string;
  fetchedAt: string;
};
