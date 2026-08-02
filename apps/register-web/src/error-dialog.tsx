export type PosError = {
  kind: "operation" | "system";
  message: string;
  errorId?: string;
  reportContent?: string;
};

export function ErrorDialog({ error, onConfirm, onStop, onCreateReport }: { error: PosError; onConfirm(): void; onStop(): void; onCreateReport?(error: PosError): void }) {
  const isSystemError = error.kind === "system";
  return <div className="modal-backdrop error-layer"><div className="error-modal"><h2>{isSystemError ? "システムエラー" : "操作できません"}</h2><p>{error.message}</p>{isSystemError && error.errorId && <p className="error-id">Error ID: {error.errorId}</p>}<div className="error-actions"><button autoFocus onClick={onConfirm}>確認</button>{isSystemError && <button className="stop-alarm" onClick={onStop}>音停止</button>}{isSystemError && error.reportContent && <button onClick={() => onCreateReport?.(error)}>エラー報告メールを作成</button>}</div></div></div>;
}
