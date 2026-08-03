import { dirname, isAbsolute, parse, resolve } from "node:path";

export function productionArtifactConfig(databasePath: string, configuredRoot: string | undefined, nodeEnv: string | undefined): { artifactRoot: string; minimumFreeBytes: number } {
  const production = nodeEnv === "production";
  const artifactRoot = configuredRoot ?? (production ? "" : resolve(dirname(databasePath), "artifacts"));
  if (!artifactRoot) throw new Error("本番ではPOS_ARTIFACT_ROOTの指定が必須です");
  if (production && !isAbsolute(artifactRoot)) throw new Error("本番のPOS_ARTIFACT_ROOTは絶対パスで指定してください");
  const resolved = resolve(artifactRoot);
  if (resolved === parse(resolved).root) throw new Error("filesystem rootは成果物保存先に指定できません");
  if (resolved === resolve(databasePath)) throw new Error("DBファイル自身は成果物保存先に指定できません");
  const raw = process.env.POS_ARTIFACT_MIN_FREE_BYTES; const minimumFreeBytes = raw === undefined ? 2 * 1024 ** 3 : Number(raw);
  if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) throw new Error("POS_ARTIFACT_MIN_FREE_BYTESは0以上の整数で指定してください");
  return { artifactRoot: resolved, minimumFreeBytes };
}
