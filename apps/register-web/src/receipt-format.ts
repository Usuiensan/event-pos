export type ReceiptAssetDescriptor = {
  assetId: string;
  version: number;
  sha256: string;
  mime: "application/x-event-pos-mono-raster";
  widthDots: number;
  heightDots: number;
  rasterBase64: string;
};

export type ReceiptFormatSettings = {
  headerText: string;
  footerText: string;
  headerAsset?: ReceiptAssetDescriptor;
  footerAsset?: ReceiptAssetDescriptor;
  printJan: boolean;
};

const yamlText = (value: string): string => JSON.stringify(value.replace(/\r\n?/g, "\n"));

export function buildReceiptTemplate(settings: ReceiptFormatSettings): string {
  const body: string[] = ["schemaVersion: 1", "body:", "  - reset: true"];
  if (settings.headerAsset) body.push(`  - image: { assetId: ${yamlText(settings.headerAsset.assetId)}, widthDots: ${settings.headerAsset.widthDots} }`);
  if (settings.headerText) body.push(`  - text: ${yamlText(settings.headerText)}`);
  body.push(
    "  - align: left",
    "  - if: isReprint",
    "    body:",
    "      - emphasis: { bold: true, underline: false, invert: true }",
    "      - text: \"{{reprintLabel}} #{{reprintNo}}\"",
    "      - text: \"元受付番号 {{originalReceiptNumber}}\"",
    "      - emphasis: { bold: false, underline: false, invert: false }",
    '  - row: { left: "受付番号", right: "{{publicReference}}" }',
    '  - row: { left: "確定日時", right: "{{confirmedAtPrinted}}" }',
    '  - row: { left: "レジ/担当", right: "{{registerNo}}/{{staffPrintLabel}}" }',
    "  - rule: single",
    "  - each: lines",
    "    body:",
    '      - text: "{{name}}"',
  );
  if (settings.printJan) body.push('      - text: "JAN {{productCode}}"');
  body.push(
    '      - row: { left: "単{{unitPriceFormatted}} × {{quantity}}", right: "{{netFormatted}}" }',
    "  - rule: single",
    "  - if: hasDiscounts",
    "    body:",
    '      - row: { left: "値引", right: "{{discountTotalFormatted}}" }',
    '  - row: { left: "税", right: "{{taxTotalFormatted}}" }',
    "  - emphasis: { bold: true, underline: false, invert: false }",
    '  - row: { left: "合計", right: "{{totalFormatted}}" }',
    "  - emphasis: { bold: false, underline: false, invert: false }",
    "  - each: payments",
    "    body:",
    '      - row: { left: "{{methodName}}", right: "{{amountFormatted}}" }',
    "  - if: hasTendered",
    "    body:",
    '      - row: { left: "預り", right: "{{tenderedFormatted}}" }',
    "  - if: hasChange",
    "    body:",
    '      - row: { left: "釣銭", right: "{{changeFormatted}}" }',
  );
  if (settings.footerAsset) body.push(`  - image: { assetId: ${yamlText(settings.footerAsset.assetId)}, widthDots: ${settings.footerAsset.widthDots} }`);
  if (settings.footerText) body.push(`  - text: ${yamlText(settings.footerText)}`);
  body.push("  - finish: { feedLines: 8, cutMode: partial }");
  return `${body.join("\n")}\n`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function rasterizeReceiptImage(file: File, assetId: string): Promise<ReceiptAssetDescriptor> {
  const image = await createImageBitmap(file);
  const widthDots = Math.max(1, Math.min(384, image.width));
  const heightDots = Math.max(1, Math.min(4096, Math.round(image.height * widthDots / Math.max(1, image.width))));
  const canvas = document.createElement("canvas"); canvas.width = widthDots; canvas.height = heightDots;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("画像変換用Canvasを初期化できません");
  context.fillStyle = "white"; context.fillRect(0, 0, widthDots, heightDots); context.drawImage(image, 0, 0, widthDots, heightDots); image.close();
  const pixels = context.getImageData(0, 0, widthDots, heightDots).data;
  const bytes = new Uint8Array(Math.ceil(widthDots / 8) * heightDots);
  for (let y = 0; y < heightDots; y += 1) for (let x = 0; x < widthDots; x += 1) {
    const pixel = (y * widthDots + x) * 4;
    const luminance = pixels[pixel]! * 0.299 + pixels[pixel + 1]! * 0.587 + pixels[pixel + 2]! * 0.114;
    if (pixels[pixel + 3]! >= 128 && luminance < 160) { const byteIndex = y * Math.ceil(widthDots / 8) + Math.floor(x / 8); bytes[byteIndex] = (bytes[byteIndex] ?? 0) | (0x80 >> (x % 8)); }
  }
  return { assetId, version: 1, sha256: await sha256(bytes), mime: "application/x-event-pos-mono-raster", widthDots, heightDots, rasterBase64: base64(bytes) };
}
