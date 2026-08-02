import { describe, expect, it } from "vitest";
import { normalizeDleEot, probeLinuxDleEot } from "./linux-status-probe.js";

describe("Linux DLE EOT raw status probe", () => {
  it("存在しないdeviceでも応答なしをreadyに変換しない", async () => {
    const result = await probeLinuxDleEot("does-not-exist", 1);
    expect(result).toHaveLength(4);
    expect(result.every((item) => item.normalized === "unknown" && item.responseHex === null && item.requestHex.startsWith("1004"))).toBe(true);
  });

  it("TM-T70IIの正常DLE EOT応答だけをreadyへ正規化する", () => {
    expect(normalizeDleEot([
      { requestHex: "100401", responseHex: "16", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100402", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100403", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100404", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
    ])).toBe("ready");
    expect(normalizeDleEot([{ requestHex: "100401", responseHex: null, normalized: "unknown", timeoutMs: 1000 }])).toBe("unknown");
  });
});
