export type SpeechPlayer = { speak(text: string): void; setSpeaker(speakerId: number): void; speakerId: number };
export type OperationSound = "register" | "cancel" | "complete" | "error";

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
const audioRevision = "voice-parts-v6-tight-crisp";
const preloaded = new Map<string, HTMLAudioElement>();
let alarmContext: AudioContext | null = null;

function preloadSpeaker(speakerId: number): void {
  if (typeof Audio === "undefined") return;
  const filenames = new Set([...Object.values(prepared).map((value) => value.split("/").at(-1)!.replace(".wav", ".mp3")), ...Object.values(yenParts).map((value) => value.replace(".wav", ".mp3"))]);
  for (const filename of filenames) {
    const directory = Object.values(yenParts).some((value) => value.replace(".wav", ".mp3") === filename) ? "yen" : "speaker";
    const url = `/audio/${directory}/${speakerId}/${filename}?v=${audioRevision}`;
    if (preloaded.has(url)) continue;
    const audio = new Audio(url); audio.preload = "auto"; audio.load(); preloaded.set(url, audio);
  }
}

export function createSpeechPlayer(options: { speakerId?: number } = {}): SpeechPlayer {
  let speakerId = options.speakerId ?? 3;
  let active: HTMLAudioElement[] = [];
  preloadSpeaker(speakerId);
  return { get speakerId() { return speakerId; }, setSpeaker(next) { speakerId = Number.isInteger(next) && next > 0 ? next : 3; preloadSpeaker(speakerId); }, speak(text) {
    for (const audio of active) { audio.pause(); audio.currentTime = 0; }
    active = [];
    const parts = text.split(" ").filter(Boolean);
    const urls: string[] = [];
    const suffixOffset = parts.at(-1) === "です" ? 1 : 0;
    const yenIndex = parts.length - 1 - suffixOffset;
    const yenPart = yenIndex >= 1 ? `${parts[yenIndex - 1]}えん` : (yenIndex === 0 ? parts[0] : undefined);
    const yenFile = yenParts[yenPart!];
    const bodyParts = yenFile ? parts.slice(0, yenIndex - 1) : parts;
    for (const part of bodyParts) if (prepared[part]) {
      const genericPath = prepared[part];
      urls.push(`/audio/speaker/${speakerId}/${genericPath.split("/").at(-1)?.replace(".wav", ".mp3")}?v=${audioRevision}`);
    } else { fallback(text); return; }
    if (yenFile) urls.push(`/audio/yen/${speakerId}/${yenFile.replace(".wav", ".mp3")}?v=${audioRevision}`);
    if (yenFile && suffixOffset) urls.push(`/audio/speaker/${speakerId}/desu.mp3?v=${audioRevision}`);
    if (urls.length && typeof Audio !== "undefined") {
      const playlist = urls.map((url) => { const audio = new Audio(url); audio.preload = "auto"; audio.playbackRate = 1; audio.load(); return audio; });
      active = playlist;
      let index = 0;
      const play = () => { const audio = playlist[index]!; audio.onended = () => { index += 1; if (index < playlist.length) play(); else active = []; }; void audio.play().catch(() => fallback(text)); };
      play(); return;
    }
    fallback(text);
  } };
}
export function playOperationSound(kind: OperationSound): void {
  if (typeof AudioContext === "undefined") return;
  if (kind === "error") {
    stopOperationSound();
    const context = new AudioContext(); const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = "square"; oscillator.frequency.value = 1450; gain.gain.value = .72;
    oscillator.connect(gain).connect(context.destination); oscillator.start(); alarmContext = context; return;
  }
  const context = new AudioContext();
  const tones: Array<readonly [number, number]> = kind === "complete" ? [[880, 0], [1320, .07]] : [[kind === "cancel" ? 330 : 1100, 0]];
  const start = context.currentTime;
  for (const [frequency, offset] of tones) {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = frequency; oscillator.type = "sine";
    gain.gain.setValueAtTime(.0001, start + offset); gain.gain.exponentialRampToValueAtTime(.42, start + offset + .006); gain.gain.exponentialRampToValueAtTime(.0001, start + offset + .09);
    oscillator.connect(gain).connect(context.destination); oscillator.start(start + offset); oscillator.stop(start + offset + .07);
  }
  window.setTimeout(() => void context.close(), 250);
}
export function stopOperationSound(): void { if (!alarmContext) return; const context = alarmContext; alarmContext = null; void context.close(); }
function fallback(text: string): void { if (typeof window === "undefined" || !("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; utterance.rate = 1.8; window.speechSynthesis.speak(utterance); }
export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech} です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("おつりをおたしかめください"); }
