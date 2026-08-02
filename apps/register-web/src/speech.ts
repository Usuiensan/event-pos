export type SpeechPlayer = { speak(text: string): void; setSpeaker(speakerId: number): void; setVolume(volume: number): void; speakerId: number; volume: number };
export type OperationSound = "tap" | "register" | "cancel" | "complete" | "error" | "system-error";
export const OPERATION_ERROR_SOUND_URL = "/audio/operation-error.mp3?v=operation-error-v1";
export const SYSTEM_ERROR_FREQUENCY_HZ = 523.25;

const prepared: Record<string, string> = {
  "円": "yen.mp3", "えん": "yen.mp3", "じゅう": "ju.mp3", "ひゃく": "hyaku.mp3", "せん": "sen.mp3", "まん": "man.mp3",
  "いち": "ichi.mp3", "に": "ni.mp3", "さん": "san.mp3", "よん": "yon.mp3", "ご": "go.mp3", "ろく": "roku.mp3", "なな": "nana.mp3", "はち": "hachi.mp3", "きゅう": "kyu.mp3",
  "ぜろえん": "zeroen.mp3",
  "にじゅう": "nijuu.mp3", "さんじゅう": "sanjuu.mp3", "よんじゅう": "yonjuu.mp3", "ごじゅう": "gojuu.mp3", "ろくじゅう": "rokujuu.mp3", "ななじゅう": "nanajuu.mp3", "はちじゅう": "hachijuu.mp3", "きゅうじゅう": "kyuujuu.mp3",
  "にせん": "nisen.mp3", "さんぜん": "sanzen.mp3", "よんせん": "yonsen.mp3", "ごせん": "gosen.mp3", "ろくせん": "rokusen.mp3", "ななせん": "nanasen.mp3", "はっせん": "hassen.mp3", "きゅうせん": "kyuusen.mp3",
  "にひゃく": "nihyaku.mp3", "さんびゃく": "sanbyaku.mp3", "よんひゃく": "yonhyaku.mp3", "ごひゃく": "gohyaku.mp3", "ろっぴゃく": "roppyaku.mp3", "ななひゃく": "nanahyaku.mp3", "はっぴゃく": "happyaku.mp3", "きゅうひゃく": "kyuuhyaku.mp3",
  "レシートをお受け取りください": "receipt.mp3",
  "お釣りを、必ずお確かめください。レシートをお受け取りください": "change-receipt.mp3",
  "年齢確認が必要です": "age-required.mp3",
  "身分証明書の提示をお願いする場合がございます": "id-request.mp3",
  "緊急情報を受信しました": "emergency-alert.mp3",
  "合計金額は": "subtotal-prefix.mp3", "です": "desu.mp3",
};
const yenParts: Record<string, string> = {
  "ぜろえん": "zeroen.mp3", "いちえん": "ichi-en.mp3", "にえん": "ni-en.mp3", "さんえん": "san-en.mp3", "よんえん": "yon-en.mp3", "ごえん": "go-en.mp3", "ろくえん": "roku-en.mp3", "ななえん": "nana-en.mp3", "はちえん": "hachi-en.mp3", "きゅうえん": "kyu-en.mp3",
  "じゅうえん": "ju-en.mp3", "にじゅうえん": "nijuu-en.mp3", "さんじゅうえん": "sanjuu-en.mp3", "よんじゅうえん": "yonjuu-en.mp3", "ごじゅうえん": "gojuu-en.mp3", "ろくじゅうえん": "rokujuu-en.mp3", "ななじゅうえん": "nanajuu-en.mp3", "はちじゅうえん": "hachijuu-en.mp3", "きゅうじゅうえん": "kyuujuu-en.mp3",
  "ひゃくえん": "hyaku-en.mp3", "にひゃくえん": "nihyaku-en.mp3", "さんびゃくえん": "sanbyaku-en.mp3", "よんひゃくえん": "yonhyaku-en.mp3", "ごひゃくえん": "gohyaku-en.mp3", "ろっぴゃくえん": "roppyaku-en.mp3", "ななひゃくえん": "nanahyaku-en.mp3", "はっぴゃくえん": "happyaku-en.mp3", "きゅうひゃくえん": "kyuuhyaku-en.mp3",
  "せんえん": "sen-en.mp3", "にせんえん": "nisen-en.mp3", "さんぜんえん": "sanzen-en.mp3", "よんせんえん": "yonsen-en.mp3", "ごせんえん": "gosen-en.mp3", "ろくせんえん": "rokusen-en.mp3", "ななせんえん": "nanasen-en.mp3", "はっせんえん": "hassen-en.mp3", "きゅうせんえん": "kyuusen-en.mp3",
};
const audioRevision = "voice-parts-v11-speed-1.25-short-gap";
// 各MP3の末尾に含まれる無音を完全に連結せず、次の音声を少し早めに開始して間を短くする。
const partOverlapSeconds = 0.06;
const decodedAudio = new Map<string, Promise<AudioBuffer>>();
let sharedAudioContext: AudioContext | null = null;
let alarmOscillator: OscillatorNode | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  sharedAudioContext ??= new AudioContext();
  return sharedAudioContext;
}

function loadAudioBuffer(url: string): Promise<AudioBuffer> {
  const existing = decodedAudio.get(url);
  if (existing) return existing;
  const context = getAudioContext();
  if (!context) return Promise.reject(new Error("Web Audio APIを利用できません"));
  const loading = fetch(url).then((response) => {
    if (!response.ok) throw new Error(`音声を取得できません: ${response.status}`);
    return response.arrayBuffer();
  }).then((data) => context.decodeAudioData(data));
  decodedAudio.set(url, loading);
  return loading;
}

function preloadSpeaker(speakerId: number): void {
  if (!getAudioContext()) return;
  const filenames = new Set([...Object.values(prepared), ...Object.values(yenParts)]);
  for (const filename of filenames) {
    const directory = Object.values(yenParts).includes(filename) ? "yen" : "speaker";
    const url = `/audio/${directory}/${speakerId}/${filename}?v=${audioRevision}`;
    void loadAudioBuffer(url).catch(() => { decodedAudio.delete(url); });
  }
}

export function createSpeechPlayer(options: { speakerId?: number } = {}): SpeechPlayer {
  let speakerId = options.speakerId ?? 3;
  let volume = 100;
  let active: AudioBufferSourceNode[] = [];
  let generation = 0;
  preloadSpeaker(speakerId);
  return { get speakerId() { return speakerId; }, get volume() { return volume; }, setVolume(next) { volume = Number.isFinite(next) ? Math.max(0, Math.min(100, next)) : 100; }, setSpeaker(next) { speakerId = Number.isInteger(next) && next > 0 ? next : 3; preloadSpeaker(speakerId); }, speak(text) {
    generation += 1;
    const requestedGeneration = generation;
    for (const source of active) { try { source.stop(); } catch { /* already stopped */ } }
    active = [];
    const parts = text.split(" ").filter(Boolean);
    const urls: string[] = [];
    const suffixOffset = parts.at(-1) === "です" ? 1 : 0;
    const yenIndex = parts.length - 1 - suffixOffset;
    const yenPart = yenIndex >= 1 ? `${parts[yenIndex - 1]}えん` : (yenIndex === 0 ? parts[0] : undefined);
    const yenFile = yenParts[yenPart!];
    const bodyParts = yenFile ? parts.slice(0, yenIndex - 1) : parts;
    for (const part of bodyParts) if (prepared[part]) {
      urls.push(`/audio/speaker/${speakerId}/${prepared[part]}?v=${audioRevision}`);
    } else { fallback(text, volume); return; }
    if (yenFile) urls.push(`/audio/yen/${speakerId}/${yenFile}?v=${audioRevision}`);
    if (yenFile && suffixOffset) urls.push(`/audio/speaker/${speakerId}/desu.mp3?v=${audioRevision}`);
    const context = getAudioContext();
    if (urls.length && context) {
      void Promise.all(urls.map(loadAudioBuffer)).then(async (buffers) => {
        if (generation !== requestedGeneration) return;
        await context.resume();
        if (generation !== requestedGeneration) return;
        let startAt = context.currentTime + .01;
        const sources = buffers.map((buffer) => {
          const source = context.createBufferSource();
          const gain = context.createGain();
          source.buffer = buffer;
          gain.gain.value = volume / 100;
          source.connect(gain);
          gain.connect(context.destination);
          source.start(startAt);
          startAt += Math.max(0, buffer.duration - partOverlapSeconds);
          return source;
        });
        active = sources;
        sources.at(-1)!.onended = () => { if (generation === requestedGeneration) active = []; };
      }).catch(() => { if (generation === requestedGeneration) fallback(text, volume); });
      return;
    }
    fallback(text, volume);
  } };
}
export function playOperationSound(kind: OperationSound, volume = 100): void {
  const context = getAudioContext();
  if (!context) return;
  const ratio = Math.max(0, Math.min(100, volume)) / 100;
  if (ratio === 0) return;
  void context.resume();
  if (kind === "system-error") {
    stopOperationSound();
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.type = "square"; oscillator.frequency.value = SYSTEM_ERROR_FREQUENCY_HZ; gain.gain.value = .72 * ratio;
    oscillator.connect(gain).connect(context.destination); oscillator.start(); alarmOscillator = oscillator; return;
  }
  if (kind === "error") {
    void loadAudioBuffer(OPERATION_ERROR_SOUND_URL).then(async (buffer) => {
      await context.resume();
      const source = context.createBufferSource(); const gain = context.createGain();
      source.buffer = buffer; gain.gain.value = ratio;
      source.connect(gain).connect(context.destination); source.start();
    }).catch(() => { /* エラー表示は音声取得失敗に依存させない */ });
    return;
  }
  const tones: Array<readonly [number, number]> = kind === "complete" ? [[880, 0], [1320, .07]] : [[kind === "cancel" ? 330 : kind === "tap" ? 820 : 1100, 0]];
  const start = context.currentTime;
  for (const [frequency, offset] of tones) {
    const oscillator = context.createOscillator(); const gain = context.createGain();
    oscillator.frequency.value = frequency; oscillator.type = "sine";
    const duration = kind === "tap" ? .045 : .07;
    gain.gain.setValueAtTime(.0001, start + offset); gain.gain.exponentialRampToValueAtTime((kind === "tap" ? .3 : .42) * ratio, start + offset + .006); gain.gain.exponentialRampToValueAtTime(.0001, start + offset + duration + .02);
    oscillator.connect(gain).connect(context.destination); oscillator.start(start + offset); oscillator.stop(start + offset + duration);
  }
}
export function previewSystemErrorSound(volume = 100, durationMs = 1_500): void {
  playOperationSound("system-error", volume);
  const previewAlarm = alarmOscillator;
  if (!previewAlarm) return;
  window.setTimeout(() => { if (alarmOscillator === previewAlarm) stopOperationSound(); }, durationMs);
}
export function stopOperationSound(): void { if (!alarmOscillator) return; const oscillator = alarmOscillator; alarmOscillator = null; try { oscillator.stop(); } catch { /* already stopped */ } oscillator.disconnect(); }
function fallback(text: string, volume: number): void { if (typeof window === "undefined" || !("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; utterance.rate = 1.25; utterance.volume = Math.max(0, Math.min(100, volume)) / 100; window.speechSynthesis.speak(utterance); }
export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech} です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("お釣りを、必ずお確かめください。レシートをお受け取りください"); }
export function speakAgeCheckRequired(player: SpeechPlayer): void { player.speak("年齢確認が必要です"); }
export function speakIdentityMayBeRequested(player: SpeechPlayer): void { player.speak("身分証明書の提示をお願いする場合がございます"); }
export function speakEmergencyAlertReceived(player: SpeechPlayer): void { player.speak("緊急情報を受信しました"); }
