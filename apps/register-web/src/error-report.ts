import type { PosError } from "./error-dialog.js";
import { createUuid } from "./uuid.js";

export type SystemErrorReport = { errorId: string; occurredAt: string; content: string };

function errorId(): string { return createUuid(); }

export function createSystemErrorReport(message: string, error?: unknown): SystemErrorReport {
  const id = errorId();
  const occurredAt = new Date().toISOString();
  const stackTrace = error instanceof Error && error.stack ? error.stack : "取得できません";
  const technicalMessage = error instanceof Error ? `${error.name}: ${error.message}` : message;
  const osInformation = typeof navigator === "undefined" ? "取得できません" : navigator.userAgent;
  const content = `POSでシステムエラーが発生しました。\n\n【ご協力ありがとうございます】\n\n以下をご記入ください。\n\n■発生日時\n${occurredAt}\n\n■どのような操作中でしたか？ \n\n○ 商品登録\n○ 会計確定\n○ レシート印刷\n○ 返金\n○ 在庫操作\n○ 設定\n○ 起動時\n○ その他 \n\n\n■毎回発生しますか？\n□毎回\n□たまに\n□今回だけ\n\n■その後レジは使用できましたか？\n□はい\n□いいえ\n\n■ご連絡先（任意）\n\n\n\n\n\n\n\n\n================================\n以下は開発者向けの技術情報です。\n\nこの情報には、エラー内容、ソフトウェアのバージョン、OS情報、\nスタックトレースなど、原因調査に必要な情報が含まれています。\n\n修正のため大変参考になります。\n\n提供を希望されない場合は、この行以降を削除して送信してください。\n\n\nこの技術情報には、氏名・住所・クレジットカード番号などの\n個人情報を送信しないよう設計しています。\n\n\nただし、コメント欄へ入力された内容や、\nログ中に商品名・会計金額などが含まれる場合があります。\n\n送信前に内容をご確認ください。 \n================================\n\nError ID\n${id}\n\n発生日時\n${occurredAt}\n\nError Message\n${technicalMessage}\n\nVersion\n${import.meta.env.VITE_APP_VERSION ?? "未取得"}\n\nGit Commit\n${import.meta.env.VITE_GIT_COMMIT ?? "未取得"}\n\nOS Information\n${osInformation}\n\nStack Trace\n${stackTrace}\n\nRecent Logs\n${technicalMessage}\n`;
  return { errorId: id, occurredAt, content };
}

export function toPosSystemError(report: SystemErrorReport, message: string): PosError {
  return { kind: "system", message, errorId: report.errorId, reportContent: report.content };
}

export function createErrorReportMailto(error: PosError): string | null {
  if (error.kind !== "system" || !error.errorId || !error.reportContent) return null;
  return `mailto:pos-error-report@usuiensan.dev?subject=${encodeURIComponent(`POSシステムエラー報告[${error.errorId}]`)}&body=${encodeURIComponent(error.reportContent)}`;
}
