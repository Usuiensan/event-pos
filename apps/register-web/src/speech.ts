export type SpeechPlayer = { speak(text: string): void };

const prepared: Record<string, string> = {
  "円": "/audio/yen.wav", "えん": "/audio/yen.wav", "じゅう": "/audio/ju.wav", "ひゃく": "/audio/hyaku.wav", "せん": "/audio/sen.wav", "まん": "/audio/man.wav",
  "いち": "/audio/ichi.wav", "に": "/audio/ni.wav", "さん": "/audio/san.wav", "よん": "/audio/yon.wav", "ご": "/audio/go.wav", "ろく": "/audio/roku.wav", "なな": "/audio/nana.wav", "はち": "/audio/hachi.wav", "きゅう": "/audio/kyu.wav",
  "にじゅう": "/audio/nijuu.wav", "さんじゅう": "/audio/sanjuu.wav", "よんじゅう": "/audio/yonjuu.wav", "ごじゅう": "/audio/gojuu.wav", "ろくじゅう": "/audio/rokujuu.wav", "ななじゅう": "/audio/nanajuu.wav", "はちじゅう": "/audio/hachijuu.wav", "きゅうじゅう": "/audio/kyuujuu.wav",
  "にせん": "/audio/nisen.wav", "さんせん": "/audio/sansen.wav", "よんせん": "/audio/yonsen.wav", "ごせん": "/audio/gosen.wav", "ろくせん": "/audio/rokusen.wav", "ななせん": "/audio/nanasen.wav", "はっせん": "/audio/hassen.wav", "きゅうせん": "/audio/kyuusen.wav",
  "にひゃく": "/audio/nihyaku.wav", "さんびゃく": "/audio/sanbyaku.wav", "よんひゃく": "/audio/yonhyaku.wav", "ごひゃく": "/audio/gohyaku.wav", "ろっぴゃく": "/audio/roppyaku.wav", "ななひゃく": "/audio/nanahyaku.wav", "はっぴゃく": "/audio/happyaku.wav", "きゅうひゃく": "/audio/kyuuhyaku.wav",
  "レシートをお受け取りください": "/audio/receipt.wav",
  "おつりをおたしかめください": "/audio/change.wav",
  "合計金額は": "/audio/subtotal-prefix.wav", "です": "/audio/desu.wav",
};

export function createSpeechPlayer(): SpeechPlayer {
  return { speak(text) {
    const parts = text.split(" ").filter(Boolean);
    const urls = parts.map((part) => prepared[part]);
    if (urls.length && urls.every(Boolean) && typeof Audio !== "undefined") {
      let index = 0; const play = () => { const audio = new Audio(urls[index]); audio.onended = () => { index += 1; if (index < urls.length) play(); }; void audio.play().catch(() => fallback(text)); }; play(); return;
    }
    fallback(text);
  } };
}
function fallback(text: string): void { if (typeof window === "undefined" || !("speechSynthesis" in window)) return; window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(text); utterance.lang = "ja-JP"; window.speechSynthesis.speak(utterance); }
export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech} です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("おつりをおたしかめください"); }
