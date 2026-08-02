import { describe, expect, it, vi } from "vitest";
import { speakChangeReady, speakReceiptReady, type SpeechPlayer } from "./speech.js";

function playerWithSpeak(spy: ReturnType<typeof vi.fn>): SpeechPlayer {
  return { speakerId: 114, setSpeaker: vi.fn(), speak: spy };
}

describe("会計完了案内", () => {
  it("お釣りなしではレシートだけを案内する", () => {
    const speak = vi.fn();
    speakReceiptReady(playerWithSpeak(speak));
    expect(speak).toHaveBeenCalledWith("レシートをお受け取りください");
  });

  it("お釣りありでは確認注意とレシートを続けて案内する", () => {
    const speak = vi.fn();
    speakChangeReady(playerWithSpeak(speak));
    expect(speak).toHaveBeenCalledWith("お釣りを必ずお確かめください レシートをお受け取りください");
  });
});
