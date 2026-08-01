export type SpeechPlayer = { speak(text: string): void };

export function createSpeechPlayer(): SpeechPlayer {
  return {
    speak(text) {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "ja-JP";
      window.speechSynthesis.speak(utterance);
    },
  };
}

export function speakProductPrice(player: SpeechPlayer, speech: string): void { player.speak(speech); }
export function speakSubtotal(player: SpeechPlayer, speech: string): void { player.speak(`${speech}です`); }
export function speakReceiptReady(player: SpeechPlayer): void { player.speak("レシートをお受け取りください"); }
export function speakChangeReady(player: SpeechPlayer): void { player.speak("おつりをおたしかめください"); }
