import { describe, expect, it, vi } from "vitest";
import { speakAgeCheckRequired, speakChangeReady, speakEmergencyAlertReceived, speakIdentityMayBeRequested, speakReceiptReady, type SpeechPlayer } from "./speech.js";

function playerWithSpeak(spy: ReturnType<typeof vi.fn>): SpeechPlayer {
  return { speakerId: 114, volume: 100, setSpeaker: vi.fn(), setVolume: vi.fn(), speak: spy };
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
    expect(speak).toHaveBeenCalledWith("お釣りを、必ずお確かめください。レシートをお受け取りください");
  });

  it("年齢確認の前後を別々に案内する", () => {
    const speak = vi.fn();
    const player = playerWithSpeak(speak);
    speakAgeCheckRequired(player);
    speakIdentityMayBeRequested(player);
    expect(speak.mock.calls).toEqual([["年齢確認が必要です"], ["身分証明書の提示をお願いする場合がございます"]]);
  });

  it("緊急情報の受信を案内する", () => {
    const speak = vi.fn();
    speakEmergencyAlertReceived(playerWithSpeak(speak));
    expect(speak).toHaveBeenCalledWith("緊急情報を受信しました");
  });
});
