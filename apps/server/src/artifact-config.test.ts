import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { productionArtifactConfig } from "./artifact-config.js";

describe("本番成果物保存先", () => {
  it("本番では絶対パスを必須にし、開発時だけDB隣接既定値を許可する", () => {
    expect(() => productionArtifactConfig("C:\\pos\\event.sqlite", undefined, "production")).toThrow("POS_ARTIFACT_ROOT");
    expect(() => productionArtifactConfig("C:\\pos\\event.sqlite", "artifacts", "production")).toThrow("絶対パス");
    expect(productionArtifactConfig("data/event.sqlite", undefined, "test").artifactRoot).toBe(resolve("data/artifacts"));
  });
});
