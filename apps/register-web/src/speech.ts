export type SpeechPlayer = { speak(text: string): void; setSpeaker(speakerId: number): void; speakerId: number };

const prepared: Record<string, string> = {
  "円": "/audio/yen.wav", "えん": "/audio/yen.wav", "じゅう": "/audio/ju.wav", "ひゃく": "/audio/hyaku.wav", "せん": "/audio/sen.wav", "まん": "/audio/man.wav",
  "いち": "/audio/ichi.wav", "に": "/audio/ni.wav", "さん": "/audio/san.wav", "よん": "/audio/yon.wav", "ご": "/audio/go.wav", "ろく": "/audio/roku.wav", "なな": "/audio/nana.wav", "はち": "/audio/hachi.wav", "きゅう": "/audio/kyu.wav",
  "ぜろえん": "/audio/zeroen.wav",
  "にじゅう": "/audio/nijuu.wav", "さんじゅう": "/audio/sanjuu.wav", "よんじゅう": "/audio/yonjuu.wav", "ごじゅう": "/audio/gojuu.wav", "ろくじゅう": "/audio/rokujuu.wav", "ななじゅう": "/audio/nanajuu.wav", "はちじゅう": "/audio/hachijuu.wav", "きゅうじゅう": "/audio/kyuujuu.wav",
  "にせん": "/audio/nisen.wav", "さんぜん": "/audio/sanzen.wav", "よんせん": "/audio/yonsen.wav", "ごせん": "/audio/gosen.wav", "ろくせん": "/audio/rokusen.wav", "ななせん": "/audio/nanasen.wav", "はっせん": "/audio/hassen.wav", "きゅうせん": "/audio/kyuusen.wav",
  "にひゃく": "/audio/nihyaku.wav", "さんびゃく": "/audio/sanbyaku.wav", "よんひゃく": "/audio/yonhyaku.wav", "ごひゃく": "/audio/gohyaku.wav", "ろっぴゃく": "/audio/roppyaku.wav", "ななひゃく": "/audio/nanahyaku.wav", "はっぴゃく": "/audio/happyaku.wav", "きゅうひゃく": "/audio/kyuuhyaku.wav",
  "レシートをお受け取りください": "/audio/receipt.wav",
  "おつりをおたしかめください": "/audio/change.wav",
  "合計金額は": "/audio/subtotal-prefix.wav", "です": "/audio/desu.wav",
};
const yenParts: Record<string, string> = {
  "ぜろえん": "zeroen.wav", "いちえん": "ichi-en.wav", "にえん": "ni-en.wav", "さんえん": "san-en.wav", "よんえん": "yon-en.wav", "ごえん": "go-en.wav", "ろくえん": "roku-en.wav", "ななえん": "nana-en.wav", "はちえん": "hachi-en.wav", "きゅうえん": "kyu-en.wav",
  "じゅうえん": "ju-en.wav", "にじゅうえん": "nijuu-en.wav", "さんじゅうえん": "sanjuu-en.wav", "よんじゅうえん": "yonjuu-en.wav", "ごじゅうえん": "gojuu-en.wav", "ろくじゅうえん": "rokujuu-en.wav", "ななじゅうえん": "nanajuu-en.wav", "はちじゅうえん": "hachijuu-en.wav", "きゅうじゅうえん": "kyuujuu-en.wav",
  "ひゃくえん": "hyaku-en.wav", "にひゃくえん": "nihyaku-en.wav", "さんびゃくえん": "sanbyaku-en.wav", "よんひゃくえん": "yonhyaku-en.wav", "ごひゃくえん": "gohyaku-en.wav", "ろっぴゃくえん": "roppyaku-en.wav", "ななひゃくえん": "nanahyaku-en.wav", "はっぴゃくえん": "happyaku-en.wav", "きゅうひゃくえん": "kyuuhyaku-en.wav",
  "せんえん": "sen-en.wav", "にせんえん": "nisen-en.wav", "さんぜんえん": "sanzen-en.wav", "よんせんえん": "yonsen-en.wav", "ごせんえん": "gosen-en.wav", "ろくせんえん": "rokusen-en.wav", "ななせんえん": "nanasen-en.wav", "はっせんえん": "hassen-en.wav", "きゅうせんえん": "kyuusen-en.wav",
};

export function createSpeechPlayer(options: { speakerId?: number } = {}): SpeechPlayer {
  let speakerId = options.speakerId ?? 1;
  let active: HTMLAudioElement[] = [];
  return { get speakerId() { return speakerId; }, setSpeaker(next) { speakerId = Number.isInteger(next) && next > 0 ? next : 1; }, speak(text) {
    for (const audio of active) { audio.pause(); audio.currentTime = 0; }
    active = [];
    const parts = text.split(" ").filter(Boolean);
    const urls: string[] = [];
    const suffixOffset = parts.at(-1) === "です" ? 1 : 0;
    const yenIndex = parts.length - 1 - suffixOffset;
    const yenPart = yenIndex >= 1 ? `${parts[yenIndex - 1]}えん` : (yenIndex === 0 ? parts[0] : undefined);
    const yenFile = yenParts[yenPart!];
    const bodyParts = yenFile ? parts.slice(0, yenIndex - 1) : parts;
    for (const part of bodyParts) if (prepared[part]) urls.push(prepared[part]); else { fallback(text); return; }
    if (yenFile) urls.push(`/audio/yen/${speakerId}/${yenFile}`);
    if (yenFile && suffixOffset) urls.push(prepared["です"]!);
    if (urls.length && typeof Audio !== "undefined") {
      let index = 0; const play = () => { const audio = new Audio(urls[index]); active.push(audio); audio.playbackRate = yenFile ? 1.8 : 1.35; audio.onended = () => { index += 1; if (index < urls.length) play(); else active = []; }; void audio.play().catch(() => fallback(text)); }; play(); return;
    }
    fallback(text);
  } };
}
function fallback(text: string): void { if (typeof window === "undefined" || !("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; utterance.rate = 1.8; window.speechSynthesis.speak(utterance); }
export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech} です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("おつりをおたしかめください"); }
