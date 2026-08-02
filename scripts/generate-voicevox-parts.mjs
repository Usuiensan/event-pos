import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const baseUrl = process.env.VOICEVOX_URL ?? "http://localhost:50021";
const speakers = (process.env.VOICEVOX_SPEAKERS ?? process.env.VOICEVOX_SPEAKER ?? "1,2,3,8,114").split(",").map(Number);
// 全話者・全セリフを通常速度の1.25倍に固定する。金額の短縮用に
// speedScale以外のモーラ長を変更すると、実効速度が1.25倍を超えるため使わない。
const speedScale = Number(process.env.VOICEVOX_SPEED_SCALE ?? 1.25);
if (!Number.isFinite(speedScale) || speedScale <= 0) throw new Error("VOICEVOX_SPEED_SCALE must be a positive number");
const requestedParts = new Set((process.env.VOICEVOX_PARTS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
const parts = {
  "えん": "yen",
  "ぜろえん": "zeroen",
  "合計金額は": "subtotal-prefix",
  "です": "desu",
  "レシートをお受け取りください": "receipt",
  "お釣りを、必ずお確かめください。レシートをお受け取りください": "change-receipt",
  "年齢確認が必要です": "age-required",
  "身分証明書の提示をお願いする場合がございます": "id-request",
  "緊急情報を受信しました": "emergency-alert",
  "じゅう": "ju", "ひゃく": "hyaku", "せん": "sen", "まん": "man",
  "いち": "ichi", "に": "ni", "さん": "san", "よん": "yon", "ご": "go", "ろく": "roku", "なな": "nana", "はち": "hachi", "きゅう": "kyu",
  "にじゅう": "nijuu", "さんじゅう": "sanjuu", "よんじゅう": "yonjuu", "ごじゅう": "gojuu", "ろくじゅう": "rokujuu", "ななじゅう": "nanajuu", "はちじゅう": "hachijuu", "きゅうじゅう": "kyuujuu",
  "にせん": "nisen", "さんぜん": "sanzen", "よんせん": "yonsen", "ごせん": "gosen", "ろくせん": "rokusen", "ななせん": "nanasen", "はっせん": "hassen", "きゅうせん": "kyuusen",
  "にひゃく": "nihyaku", "さんびゃく": "sanbyaku", "よんひゃく": "yonhyaku", "ごひゃく": "gohyaku", "ろっぴゃく": "roppyaku", "ななひゃく": "nanahyaku", "はっぴゃく": "happyaku", "きゅうひゃく": "kyuuhyaku",
};
async function synthesize(text, speaker) {
  const queryResponse = await fetch(`${baseUrl}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`, { method: "POST" });
  if (!queryResponse.ok) throw new Error(`audio_query ${text}: ${queryResponse.status}`);
  const query = await queryResponse.json();
  // VOICEVOX's AccentPhrase API requires a 1-based mora position. Placing the
  // accent nucleus at the phrase end gives the flat/readout-style contour.
  const flatPhrases = query.accent_phrases.map((phrase) => ({
    ...phrase,
    accent: Math.max(1, phrase.moras.length),
  }));
  const moraResponse = await fetch(`${baseUrl}/mora_data?speaker=${speaker}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(flatPhrases) });
  if (!moraResponse.ok) throw new Error(`mora_data ${text}: ${moraResponse.status}`);
  query.accent_phrases = await moraResponse.json();
  query.speedScale = speedScale;
  const synthesisResponse = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query) });
  if (!synthesisResponse.ok) throw new Error(`synthesis ${text}: ${synthesisResponse.status}`);
  return Buffer.from(await synthesisResponse.arrayBuffer());
}
async function writeMp3(outputPath, wav) {
  const temporaryPath = `${outputPath}.${process.pid}.wav`;
  await fs.writeFile(temporaryPath, wav);
  try {
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", temporaryPath, "-codec:a", "libmp3lame", "-b:a", "64k", "-ac", "1", outputPath]);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
const yenParts = {
  "ぜろえん": "zeroen", "いちえん": "ichi-en", "にえん": "ni-en", "さんえん": "san-en", "よんえん": "yon-en", "ごえん": "go-en", "ろくえん": "roku-en", "ななえん": "nana-en", "はちえん": "hachi-en", "きゅうえん": "kyu-en",
  "じゅうえん": "ju-en", "にじゅうえん": "nijuu-en", "さんじゅうえん": "sanjuu-en", "よんじゅうえん": "yonjuu-en", "ごじゅうえん": "gojuu-en", "ろくじゅうえん": "rokujuu-en", "ななじゅうえん": "nanajuu-en", "はちじゅうえん": "hachijuu-en", "きゅうじゅうえん": "kyuujuu-en",
  "ひゃくえん": "hyaku-en", "にひゃくえん": "nihyaku-en", "さんびゃくえん": "sanbyaku-en", "よんひゃくえん": "yonhyaku-en", "ごひゃくえん": "gohyaku-en", "ろっぴゃくえん": "roppyaku-en", "ななひゃくえん": "nanahyaku-en", "はっぴゃくえん": "happyaku-en", "きゅうひゃくえん": "kyuuhyaku-en",
  "せんえん": "sen-en", "にせんえん": "nisen-en", "さんぜんえん": "sanzen-en", "よんせんえん": "yonsen-en", "ごせんえん": "gosen-en", "ろくせんえん": "rokusen-en", "ななせんえん": "nanasen-en", "はっせんえん": "hassen-en", "きゅうせんえん": "kyuusen-en",
};
for (const speaker of speakers) {
  const outDir = path.resolve("apps/register-web/public/audio/speaker", String(speaker));
  const yenDir = path.resolve("apps/register-web/public/audio/yen", String(speaker));
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(yenDir, { recursive: true });
  for (const [text, file] of Object.entries(parts)) {
    if (requestedParts.size > 0 && !requestedParts.has(file)) continue;
    await writeMp3(path.join(outDir, `${file}.mp3`), await synthesize(text, speaker));
    console.log(`[${speaker}] ${text} -> ${file}.mp3`);
  }
  for (const [text, file] of Object.entries(yenParts)) {
    if (requestedParts.size > 0 && !requestedParts.has(file)) continue;
    await writeMp3(path.join(yenDir, `${file}.mp3`), await synthesize(text, speaker));
    console.log(`[${speaker}] ${text} -> yen/${file}.mp3`);
  }
}
