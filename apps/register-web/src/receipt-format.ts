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
  if (itemType(items[footerIndex] ?? []).startsWith("barcode:")) footerIndex -= 1;
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
    '      - row: { left: "単¥{{unitPriceFormatted}} × {{quantity}}", right: "{{netFormatted}}" }',
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
  body.push('  - barcode: { value: "{BPS14{{businessDateYYMMDD}}{{publicReferenceRaw}}", width: 3, height: 96, hri: below }');
  body.push("  - finish: { feedLines: 8, cutMode: partial }");
  return `${body.join("\n")}\n`;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  return btoa(binary);
}

export function sha256Fallback(bytes: Uint8Array): string {
  const k = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const bitLength = bytes.length * 8; const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64; const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer); view.setUint32(paddedLength - 4, bitLength >>> 0); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  const rotr = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Uint32Array(64); for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) { const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3); const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10); w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0; }
    let [a, b, c, d, e, f, g, j] = h as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) { const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25); const ch = (e & f) ^ (~e & g); const t1 = (j + s1 + ch + k[i]! + w[i]!) >>> 0; const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22); const maj = (a & b) ^ (a & c) ^ (b & c); const t2 = (s0 + maj) >>> 0; [j, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0]; }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0; h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + j) >>> 0;
  }
  return h.map((value) => value.toString(16).padStart(8, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) return sha256Fallback(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
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
