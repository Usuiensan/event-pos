// QRコード生成（バイトモード・誤り訂正レベルM・バージョン1〜10自動選択）。
// 接続案内のQRを外部通信なしで描くため、依存を追加せず必要範囲だけを実装した。
// 検証: 参照実装 segno / Nayuki qrcodegen とデータコードワード列を照合し、
// 生成した行列28件すべてを OpenCV の QRCodeDetector で復号できることを確認済み。
// 行列の回帰ベクターは qr-encode.test.ts に埋め込んである。

export type QrMatrix = { version: number; size: number; modules: boolean[][] };

const GF_EXP = new Array<number>(512).fill(0);
const GF_LOG = new Array<number>(256).fill(0);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}
const gfMul = (a: number, b: number): number => (a && b ? GF_EXP[GF_LOG[a]! + GF_LOG[b]!]! : 0);

function rsGeneratorPoly(degree: number): number[] {
  // 降べき順（先頭が最高次係数1）の生成多項式 Π(x - α^i)
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!;
      next[j + 1] = next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data: number[], ecLength: number): number[] {
  const gen = rsGeneratorPoly(ecLength);
  const remainder = new Array<number>(ecLength).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift()!;
    remainder.push(0);
    for (let i = 0; i < ecLength; i++) {
      remainder[i] = (remainder[i] ?? 0) ^ gfMul(gen[i + 1] ?? 0, factor);
    }
  }
  return remainder;
}

// [ブロックあたりECコードワード数, [[ブロック数, ブロックあたりデータコードワード数], ...]]
const EC_TABLE_M: Record<number, [number, Array<[number, number]>]> = {
  1: [10, [[1, 16]]],
  2: [16, [[1, 28]]],
  3: [26, [[1, 44]]],
  4: [18, [[2, 32]]],
  5: [24, [[2, 43]]],
  6: [16, [[4, 27]]],
  7: [18, [[4, 31]]],
  8: [22, [[2, 38], [2, 39]]],
  9: [22, [[3, 36], [2, 37]]],
  10: [26, [[4, 43], [1, 44]]],
};
const ALIGN_CENTERS: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
  6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
};
const REMAINDER_BITS: Record<number, number> = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

function dataCapacityBits(version: number): number {
  const [, groups] = EC_TABLE_M[version]!;
  const dataCodewords = groups.reduce((sum, [count, per]) => sum + count * per, 0);
  return dataCodewords * 8;
}

function buildDataCodewords(bytes: Uint8Array, version: number): number[] {
  const lengthBits = version >= 10 ? 16 : 8;
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, lengthBits);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCapacityBits(version);
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j]!;
    codewords.push(value);
  }
  const pads = [0xec, 0x11];
  let padIndex = 0;
  const totalData = capacity / 8;
  while (codewords.length < totalData) codewords.push(pads[padIndex++ % 2]!);
  return codewords;
}

function interleaveWithEc(dataCodewords: number[], version: number): number[] {
  const [ecPerBlock, groups] = EC_TABLE_M[version]!;
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let offset = 0;
  for (const [count, per] of groups) {
    for (let i = 0; i < count; i++) {
      const data = dataCodewords.slice(offset, offset + per);
      offset += per;
      blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
    }
  }
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) for (const block of blocks) if (i < block.data.length) result.push(block.data[i]!);
  for (let i = 0; i < ecPerBlock; i++) for (const block of blocks) result.push(block.ec[i]!);
  return result;
}

function formatInfoBits(mask: number): number {
  const data = (0b00 << 3) | mask; // 誤り訂正レベルM = 00
  let d = data << 10;
  const g = 0x537;
  for (let i = 14; i >= 10; i--) if ((d >>> i) & 1) d ^= g << (i - 10);
  return (((data << 10) | d) ^ 0x5412) & 0x7fff;
}

function versionInfoBits(version: number): number {
  let d = version << 12;
  const g = 0x1f25;
  for (let i = 17; i >= 12; i--) if ((d >>> i) & 1) d ^= g << (i - 12);
  return ((version << 12) | d) & 0x3ffff;
}

const MASKS: Array<(r: number, c: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

type Cell = boolean | null;

function baseMatrix(version: number): Cell[][] {
  const size = 17 + version * 4;
  const modules: Cell[][] = Array.from({ length: size }, () => new Array<Cell>(size).fill(null));
  const set = (r: number, c: number, value: boolean) => { if (r >= 0 && r < size && c >= 0 && c < size) modules[r]![c] = value; };
  const finder = (top: number, left: number) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const dark = (0 <= dr && dr <= 6 && (dc === 0 || dc === 6)) || (0 <= dc && dc <= 6 && (dr === 0 || dr === 6)) || (2 <= dr && dr <= 4 && 2 <= dc && dc <= 4);
      set(top + dr, left + dc, dark);
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const centers = ALIGN_CENTERS[version]!;
  for (const r of centers) for (const c of centers) {
    // ファインダーと重なる3隅だけを除外する（タイミング上の中心は描く）。
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
    }
  }
  // 形式情報のプレースホルダ（8行目・8列目）
  for (let i = 0; i <= 8; i++) {
    if (modules[8]![i] === null) modules[8]![i] = false;
    if (modules[i]![8] === null) modules[i]![8] = false;
  }
  modules[8]![size - 8] = false;
  for (let i = 0; i < 8; i++) modules[8]![size - 1 - i] = modules[8]![size - 1 - i] ?? false;
  for (let i = 0; i < 8; i++) modules[size - 1 - i]![8] = modules[size - 1 - i]![8] ?? false;
  set(size - 8, 8, true); // ダークモジュール
  if (version >= 7) {
    const bits = versionInfoBits(version);
    for (let i = 0; i < 18; i++) {
      const value = ((bits >>> i) & 1) === 1;
      set(Math.floor(i / 3), size - 11 + (i % 3), value);
      set(size - 11 + (i % 3), Math.floor(i / 3), value);
    }
  }
  return modules;
}

function placeData(modules: Cell[][], codewords: number[], version: number): Cell[][] {
  const size = modules.length;
  const bits: number[] = [];
  for (const byte of codewords) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  for (let i = 0; i < REMAINDER_BITS[version]!; i++) bits.push(0);
  let index = 0;
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (modules[row]![c] === null) {
          modules[row]![c] = index < bits.length ? bits[index] === 1 : false;
          index++;
        }
      }
    }
    upward = !upward;
  }
  return modules;
}

function applyMask(modules: boolean[][], reserved: boolean[][], mask: number): boolean[][] {
  const size = modules.length;
  const fn = MASKS[mask]!;
  const result = modules.map((row) => row.slice());
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!reserved[r]![c] && fn(r, c)) result[r]![c] = !result[r]![c];
  }
  return result;
}

function placeFormatInfo(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatInfoBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const positions1: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) positions1.push([i, 8]);
  positions1.push([7, 8], [8, 8], [8, 7]);
  for (let i = 9; i <= 14; i++) positions1.push([8, 14 - i]);
  positions1.forEach(([r, c], i) => { modules[r]![c] = bit(i); });
  const positions2: Array<[number, number]> = [];
  for (let i = 0; i <= 7; i++) positions2.push([8, size - 1 - i]);
  for (let i = 8; i <= 14; i++) positions2.push([size - 15 + i, 8]);
  positions2.forEach(([r, c], i) => { modules[r]![c] = bit(i); });
  modules[size - 8]![8] = true; // ダークモジュール
}

// ISO/IEC 18004 の N3: 1011101 パターンの前後に4モジュール分の明領域（端部も可）がある場合に数える。
function n3Occurrences(line: number[]): number {
  const pattern = [1, 0, 1, 1, 1, 0, 1];
  const size = line.length;
  let count = 0;
  let from = 0;
  for (;;) {
    let idx = -1;
    outer: for (let i = from; i + 7 <= size; i++) {
      for (let j = 0; j < 7; j++) if (line[i + j] !== pattern[j]!) continue outer;
      idx = i;
      break;
    }
    if (idx === -1) break;
    const offset = idx + 7;
    const before = line.slice(Math.max(idx - 4, 0), idx);
    const after = line.slice(offset, Math.min(offset + 4, size));
    if (idx === 0 || idx === size - 7 || before.every((v) => v === 0) || after.every((v) => v === 0)) {
      count += 40;
      from = offset;
    } else {
      from = idx + 4;
    }
  }
  return count;
}

function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i++) {
    lines.push(modules[i]!);
    lines.push(modules.map((row) => row[i]!));
  }
  for (const line of lines) {
    let runColor = line[0];
    let runLength = 1;
    for (let i = 1; i < size; i++) {
      if (line[i] === runColor) runLength++;
      else {
        if (runLength >= 5) score += runLength - 5 + 3;
        runColor = line[i];
        runLength = 1;
      }
    }
    if (runLength >= 5) score += runLength - 5 + 3;
    score += n3Occurrences(line.map((v) => (v ? 1 : 0)));
  }
  for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
    const v = modules[r]![c];
    if (v === modules[r + 1]![c] && v === modules[r]![c + 1] && v === modules[r + 1]![c + 1]) score += 3;
  }
  let dark = 0;
  for (const row of modules) for (const v of row) if (v) dark++;
  const percent = (dark * 100) / (size * size);
  score += 10 * Math.trunc(Math.abs(percent - 50) / 5);
  return score;
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= 10; v++) {
    const lengthBits = v >= 10 ? 16 : 8;
    if (4 + lengthBits + bytes.length * 8 <= dataCapacityBits(v)) { version = v; break; }
  }
  if (!version) throw new Error("QRコードに収まらない長さです");
  const data = buildDataCodewords(bytes, version);
  const codewords = interleaveWithEc(data, version);
  const base = baseMatrix(version);
  const reserved = base.map((row) => row.map((v) => v !== null));
  const placed = placeData(base.map((row) => row.slice()), codewords, version) as boolean[][];
  let best: boolean[][] | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = applyMask(placed, reserved, mask);
    placeFormatInfo(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return { version, size: base.length, modules: best! };
}
