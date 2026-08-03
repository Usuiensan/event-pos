/** ISDN（国際標準同人誌番号）の公開XMLから取得した商品情報。 */
export type IsdnProductInfo = {
  code: string;
  displayCode?: string;
  productName: string;
  productYomi?: string;
  publisherCode?: string;
  publisherName?: string;
  publisherYomi?: string;
  issueDate?: string;
  genreName?: string;
  ratingAge?: string;
  author?: string;
  shape?: string;
  contents?: string;
  price?: number;
  priceUnit?: string;
  barcode2?: string;
  sampleImageUri?: string;
  sourceUrl: string;
  fetchedAt: string;
};
