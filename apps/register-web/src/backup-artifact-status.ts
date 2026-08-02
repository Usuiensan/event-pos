import type { BackupArtifactDto } from "./checkout-api.js";

export type BackupArtifactStatusView = { label: string; className: "pending" | "generating" | "completed" | "failed"; description: string };

export function formatBackupArtifactStatus(artifact: Pick<BackupArtifactDto, "state" | "errorMessage">): BackupArtifactStatusView {
  if (artifact.state === "pending") return { label: "生成待ち", className: "pending", description: "点検・精算は確定済みです。成果物の生成開始を待っています。" };
  if (artifact.state === "generating") return { label: "生成中", className: "generating", description: "SQLite snapshot、Excel、manifestを検証しています。" };
  if (artifact.state === "completed") return { label: "成功", className: "completed", description: "3ファイルの生成とhash検証が完了しました。" };
  return { label: "失敗", className: "failed", description: artifact.errorMessage ?? "成果物を生成できませんでした。点検・精算の確定データは保持されています。" };
}
