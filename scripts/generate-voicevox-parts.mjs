import fs from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.VOICEVOX_URL ?? "http://localhost:50021";
const speakers = (process.env.VOICEVOX_SPEAKERS ?? process.env.VOICEVOX_SPEAKER ?? "1,3,8,114").split(",").map(Number);
const parts = {
  "えん": "yen",
  "ぜろえん": "zeroen",
  "合計金額は": "subtotal-prefix",
  "です": "desu",
  "レシートをお受け取りください": "receipt",
  "おつりをおたしかめください": "change",
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
  const synthesisResponse = await fetch(`${baseUrl}/synthesis?speaker=${speaker}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(query) });
  if (!synthesisResponse.ok) throw new Error(`synthesis ${text}: ${synthesisResponse.status}`);
  return Buffer.from(await synthesisResponse.arrayBuffer());
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
    await fs.writeFile(path.join(outDir, `${file}.wav`), await synthesize(text, speaker));
    console.log(`[${speaker}] ${text} -> ${file}.wav`);
  }
  for (const [text, file] of Object.entries(yenParts)) {
    await fs.writeFile(path.join(yenDir, `${file}.wav`), await synthesize(text, speaker));
    console.log(`[${speaker}] ${text} -> yen/${file}.wav`);
  }
}
