import { afterEach, describe, expect, it, vi } from "vitest";
import { audioSettingsStorageKey, defaultAudioSettings, loadAudioSettings, normalizeAudioSettings, storeAudioSettings } from "./audio-settings.js";

afterEach(() => vi.unstubAllGlobals());

describe("独立音量設定", () => {
  it("4種類を0～100で独立して保存・復元する", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const settings = normalizeAudioSettings({ ...defaultAudioSettings, tapVolume: 0, errorVolume: 37, systemErrorVolume: 63, speechVolume: 100, speakerId: 114, version: 2 });
    storeAudioSettings(2, settings);
    expect(values.has(audioSettingsStorageKey(2))).toBe(true);
    expect(loadAudioSettings(2)).toMatchObject({ tapVolume: 0, errorVolume: 37, systemErrorVolume: 63, speechVolume: 100, speakerId: 114, version: 2 });
  });

  it("壊れた値だけ既定値へ戻す", () => {
    expect(normalizeAudioSettings({ tapVolume: -1, errorVolume: 101, systemErrorVolume: -1, speechVolume: 45 })).toMatchObject({ tapVolume: 100, errorVolume: 100, systemErrorVolume: 100, speechVolume: 45 });
  });
});
