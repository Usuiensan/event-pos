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

export type ParsedReceiptFormatSettings = {
  headerText: string;
  footerText: string;
  headerAssetId: string;
  footerAssetId: string;
  printJan: boolean;
};

const yamlText = (value: string): string => JSON.stringify(value.replace(/\r\n?/g, "\n"));

export function parseReceiptFormatSettings(sourceText: string): ParsedReceiptFormatSettings | null {
  const lines = sourceText.split(/\r\n?|\n/);
  if (lines[0] !== "schemaVersion: 1" || lines[1] !== "body:") return null;
  const items: string[][] = [];
  for (const line of lines.slice(2)) {
    if (line.startsWith("  - ")) items.push([line]);
    else if (items.length > 0) items[items.length - 1]!.push(line);
  }
  if (!items[0]?.[0]?.startsWith("  - reset: true")) return null;

  const itemType = (item: string[]) => item[0]?.slice(4).trim() ?? "";
  const imageAssetId = (item: string[]) => {
    const match = item[0]!.match(/\{\s*assetId:\s*("(?:[^"\\]|\\.)*"|[^,}\s]+)/);
    if (!match) return null;
    if (match[1]!.startsWith('"')) {
      try { return JSON.parse(match[1]!) as string; } catch { return null; }
    }
    return match[1]!;
  };
  const textValue = (item: string[]) => {
    const value = item[0]!.match(/^  - text: (.*)$/)?.[1];
    if (value === undefined) return null;
    if (!value.startsWith('"')) return value;
    try { return JSON.parse(value) as string; } catch { return null; }
  };

  let index = 1;
  let headerAssetId = "";
  if (items[index] && itemType(items[index]!).startsWith("image:")) {
    const assetId = imageAssetId(items[index]!);
    if (assetId === null) return null;
    headerAssetId = assetId;
    index += 1;
  }
  let headerText = "";
  if (itemType(items[index] ?? []) === "align: left") index += 1;
  else {
    if (itemType(items[index] ?? []) !== "align: center" || !itemType(items[index + 1] ?? []).startsWith("emphasis: { bold: true")) return null;
    index += 2;
    const headerLines: string[] = [];
    while (items[index] && itemType(items[index]!).startsWith("text:")) {
      const value = textValue(items[index]!);
      if (value === null) return null;
      headerLines.push(value);
      index += 1;
    }
    if (!itemType(items[index] ?? []).startsWith("emphasis: { bold: false") || itemType(items[index + 1] ?? []) !== "align: left") return null;
    headerText = headerLines.join("\n");
  }

  const finishIndex = items.length - 1;
  if (!itemType(items[finishIndex] ?? []).startsWith("finish:")) return null;
  let footerIndex = finishIndex - 1;
  const footerLines: string[] = [];
  while (footerIndex >= 0 && itemType(items[footerIndex]!).startsWith("text:")) {
    const value = textValue(items[footerIndex]!);
    if (value === null) return null;
    footerLines.unshift(value);
    footerIndex -= 1;
  }
  let footerAssetId = "";
  if (footerIndex >= 0 && itemType(items[footerIndex]!).startsWith("image:")) {
    const assetId = imageAssetId(items[footerIndex]!);
    if (assetId === null) return null;
    footerAssetId = assetId;
  }
  return { headerText, footerText: footerLines.join("\n"), headerAssetId, footerAssetId, printJan: sourceText.includes('text: "JAN {{productCode}}"') };
}

export function buildReceiptTemplate(settings: ReceiptFormatSettings): string {
  const body: string[] = ["schemaVersion: 1", "body:", "  - reset: true"];
  if (settings.headerAsset) body.push(`  - image: { assetId: ${yamlText(settings.headerAsset.assetId)}, widthDots: ${settings.headerAsset.widthDots} }`);
  if (settings.headerText) {
    body.push(
      "  - align: center",
      "  - emphasis: { bold: true, underline: false, invert: false }",
      ...settings.headerText.replace(/\r\n?/g, "\n").split("\n").map((line) => `  - text: ${yamlText(line)}`),
      "  - emphasis: { bold: false, underline: false, invert: false }",
      "  - align: left",
    );
  }
  else body.push("  - align: left");
  body.push(
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
  if (settings.footerText) body.push(...settings.footerText.replace(/\r\n?/g, "\n").split("\n").map((line) => `  - text: ${yamlText(line)}`));
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
