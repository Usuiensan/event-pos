import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllGlobals());

describe("AudioBuffer音声再生", () => {
  it("共有AudioContext上で音声パーツを切れ目なく予約する", async () => {
    const starts: number[] = [];
    let contextCount = 0;
    class FakeAudioContext {
      currentTime = 10;
      destination = {};
      constructor() { contextCount += 1; }
      resume = vi.fn(async () => undefined);
      decodeAudioData = vi.fn(async () => ({ duration: .5 } as AudioBuffer));
      createBufferSource() {
        return { buffer: null, onended: null, connect: vi.fn(), start: (at: number) => starts.push(at), stop: vi.fn() } as unknown as AudioBufferSourceNode;
      }
      createOscillator() { return { frequency: { value: 0 }, type: "sine", connect() { return this; }, start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() } as unknown as OscillatorNode; }
      createGain() { return { gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect() { return this; } } as unknown as GainNode; }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    const { createSpeechPlayer, playOperationSound } = await import("./speech.js");

    const player = createSpeechPlayer({ speakerId: 114 });
    player.speak("いち まん にせん えん");
    playOperationSound("tap");
    playOperationSound("register");

    await vi.waitFor(() => expect(starts).toHaveLength(3));
    expect(starts).toEqual([10.01, 10.51, 11.01]);
    expect(contextCount).toBe(1);
  });
});
