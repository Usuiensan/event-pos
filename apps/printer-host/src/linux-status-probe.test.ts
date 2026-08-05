import { describe, expect, it } from "vitest";
import { decodeDleEot, normalizeDleEot, probeLinuxDleEot } from "./linux-status-probe.js";

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

  it("DLE EOTのonline、cover、紙、error、drawer pin3を共通状態へ変換する", () => {
    const observation = decodeDleEot([
      { requestHex: "100401", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100402", responseHex: "04", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100403", responseHex: "04", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100404", responseHex: "0c", normalized: "unknown", timeoutMs: 1000 },
    ], true);
    expect(observation).toMatchObject({ online: { support: "supported", value: true }, coverOpen: { support: "supported", value: true }, drawerOpen: { support: "supported", value: false }, paper: { support: "supported", value: "near_end" }, error: { support: "supported", value: "recoverable" } });
    expect(observation.raw).toMatchObject({ protocol: "escpos-dle-eot", drawerSignalHigh: false });
  });

  it("drawer pin3の開状態極性が未校正ならunknownを維持する", () => {
    const observation = decodeDleEot([
      { requestHex: "100401", responseHex: "16", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100402", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100403", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100404", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
    ]);
    expect(observation.drawerOpen).toMatchObject({ support: "unknown" });
  });

  it("応答不足ではreachableを含めてunknownにする", () => {
    const observation = decodeDleEot([
      { requestHex: "100401", responseHex: "16", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100402", responseHex: null, normalized: "unknown", timeoutMs: 1000, error: "timeout" },
      { requestHex: "100403", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
      { requestHex: "100404", responseHex: "12", normalized: "unknown", timeoutMs: 1000 },
    ]);
    expect(observation.reachable).toMatchObject({ support: "unknown" });
    expect(observation.drawerOpen).toMatchObject({ support: "unknown" });
  });
});
