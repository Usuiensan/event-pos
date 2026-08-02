export type PosError = {
  kind: "operation" | "system";
  message: string;
};

export function ErrorDialog({ error, onConfirm, onStop }: { error: PosError; onConfirm(): void; onStop(): void }) {
  const isSystemError = error.kind === "system";
  return <div className="modal-backdrop error-layer"><div className="error-modal"><h2>{isSystemError ? "システムエラー" : "操作できません"}</h2><p>{error.message}</p><div className="error-actions"><button autoFocus onClick={onConfirm}>確認</button>{isSystemError && <button className="stop-alarm" onClick={onStop}>音停止</button>}</div></div></div>;
}
