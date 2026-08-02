export type SpeechPlayer = { speak(text: string): void; setSpeaker(speakerId: number): void; setVolume(volume: number): void; speakerId: number; volume: number };
export type OperationSound = "tap" | "register" | "cancel" | "complete" | "error" | "system-error";
export const OPERATION_ERROR_SOUND_URL = "/audio/operation-error.mp3?v=operation-error-v1";
export const SYSTEM_ERROR_FREQUENCY_HZ = 523.25;

const prepared: Record<string, string> = {
  "円": "/audio/yen.wav", "えん": "/audio/yen.wav", "じゅう": "/audio/ju.wav", "ひゃく": "/audio/hyaku.wav", "せん": "/audio/sen.wav", "まん": "/audio/man.wav",
  "いち": "/audio/ichi.wav", "に": "/audio/ni.wav", "さん": "/audio/san.wav", "よん": "/audio/yon.wav", "ご": "/audio/go.wav", "ろく": "/audio/roku.wav", "なな": "/audio/nana.wav", "はち": "/audio/hachi.wav", "きゅう": "/audio/kyu.wav",
  "ぜろえん": "/audio/zeroen.wav",
  "にじゅう": "/audio/nijuu.wav", "さんじゅう": "/audio/sanjuu.wav", "よんじゅう": "/audio/yonjuu.wav", "ごじゅう": "/audio/gojuu.wav", "ろくじゅう": "/audio/rokujuu.wav", "ななじゅう": "/audio/nanajuu.wav", "はちじゅう": "/audio/hachijuu.wav", "きゅうじゅう": "/audio/kyuujuu.wav",
  "にせん": "/audio/nisen.wav", "さんぜん": "/audio/sanzen.wav", "よんせん": "/audio/yonsen.wav", "ごせん": "/audio/gosen.wav", "ろくせん": "/audio/rokusen.wav", "ななせん": "/audio/nanasen.wav", "はっせん": "/audio/hassen.wav", "きゅうせん": "/audio/kyuusen.wav",
  "にひゃく": "/audio/nihyaku.wav", "さんびゃく": "/audio/sanbyaku.wav", "よんひゃく": "/audio/yonhyaku.wav", "ごひゃく": "/audio/gohyaku.wav", "ろっぴゃく": "/audio/roppyaku.wav", "ななひゃく": "/audio/nanahyaku.wav", "はっぴゃく": "/audio/happyaku.wav", "きゅうひゃく": "/audio/kyuuhyaku.wav",
  "レシートをお受け取りください": "/audio/receipt.wav",
  "お釣りを、必ずお確かめください。レシートをお受け取りください": "/audio/change-receipt.wav",
  "年齢確認が必要です": "/audio/age-required.wav",
  "身分証明書の提示をお願いする場合がございます": "/audio/id-request.wav",
  "緊急情報を受信しました": "/audio/emergency-alert.wav",
  "合計金額は": "/audio/subtotal-prefix.wav", "です": "/audio/desu.wav",
};
const yenParts: Record<string, string> = {
  "ぜろえん": "zeroen.wav", "いちえん": "ichi-en.wav", "にえん": "ni-en.wav", "さんえん": "san-en.wav", "よんえん": "yon-en.wav", "ごえん": "go-en.wav", "ろくえん": "roku-en.wav", "ななえん": "nana-en.wav", "はちえん": "hachi-en.wav", "きゅうえん": "kyu-en.wav",
  "じゅうえん": "ju-en.wav", "にじゅうえん": "nijuu-en.wav", "さんじゅうえん": "sanjuu-en.wav", "よんじゅうえん": "yonjuu-en.wav", "ごじゅうえん": "gojuu-en.wav", "ろくじゅうえん": "rokujuu-en.wav", "ななじゅうえん": "nanajuu-en.wav", "はちじゅうえん": "hachijuu-en.wav", "きゅうじゅうえん": "kyuujuu-en.wav",
  "ひゃくえん": "hyaku-en.wav", "にひゃくえん": "nihyaku-en.wav", "さんびゃくえん": "sanbyaku-en.wav", "よんひゃくえん": "yonhyaku-en.wav", "ごひゃくえん": "gohyaku-en.wav", "ろっぴゃくえん": "roppyaku-en.wav", "ななひゃくえん": "nanahyaku-en.wav", "はっぴゃくえん": "happyaku-en.wav", "きゅうひゃくえん": "kyuuhyaku-en.wav",
  "せんえん": "sen-en.wav", "にせんえん": "nisen-en.wav", "さんぜんえん": "sanzen-en.wav", "よんせんえん": "yonsen-en.wav", "ごせんえん": "gosen-en.wav", "ろくせんえん": "rokusen-en.wav", "ななせんえん": "nanasen-en.wav", "はっせんえん": "hassen-en.wav", "きゅうせんえん": "kyuusen-en.wav",
};
const audioRevision = "voice-parts-v9-emergency-alert";
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
  const filenames = new Set([...Object.values(prepared).map((value) => value.split("/").at(-1)!.replace(".wav", ".mp3")), ...Object.values(yenParts).map((value) => value.replace(".wav", ".mp3"))]);
  for (const filename of filenames) {
    const directory = Object.values(yenParts).some((value) => value.replace(".wav", ".mp3") === filename) ? "yen" : "speaker";
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
      const genericPath = prepared[part];
      urls.push(`/audio/speaker/${speakerId}/${genericPath.split("/").at(-1)?.replace(".wav", ".mp3")}?v=${audioRevision}`);
    } else { fallback(text, volume); return; }
    if (yenFile) urls.push(`/audio/yen/${speakerId}/${yenFile.replace(".wav", ".mp3")}?v=${audioRevision}`);
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
          startAt += buffer.duration;
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
export function stopOperationSound(): void { if (!alarmOscillator) return; const oscillator = alarmOscillator; alarmOscillator = null; try { oscillator.stop(); } catch { /* already stopped */ } oscillator.disconnect(); }
function fallback(text: string, volume: number): void { if (typeof window === "undefined" || !("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; utterance.rate = 1.8; utterance.volume = Math.max(0, Math.min(100, volume)) / 100; window.speechSynthesis.speak(utterance); }
export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech} です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("お釣りを、必ずお確かめください。レシートをお受け取りください"); }
export function speakAgeCheckRequired(player: SpeechPlayer): void { player.speak("年齢確認が必要です"); }
export function speakIdentityMayBeRequested(player: SpeechPlayer): void { player.speak("身分証明書の提示をお願いする場合がございます"); }
export function speakEmergencyAlertReceived(player: SpeechPlayer): void { player.speak("緊急情報を受信しました"); }
