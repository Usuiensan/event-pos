import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ErrorDialog } from "./error-dialog.js";

describe("エラー表示", () => {
  it("誤操作エラーでは音停止ボタンをDOMへ出さない", () => {
    const html = renderToStaticMarkup(<ErrorDialog error={{ kind: "operation", message: "入力を確認してください" }} onConfirm={vi.fn()} onStop={vi.fn()} />);
    expect(html).toContain("操作できません");
    expect(html).not.toContain("音停止");
    expect(html).not.toContain("stop-alarm");
  });

  it("システムエラーでは警報を止められる", () => {
    const html = renderToStaticMarkup(<ErrorDialog error={{ kind: "system", message: "通信に失敗しました", errorId: "019fc3fb-f939-7e30-8175-635f2866b280", reportContent: "report" }} onConfirm={vi.fn()} onStop={vi.fn()} onCreateReport={vi.fn()} />);
    expect(html).toContain("システムエラー");
    expect(html).toContain("音停止");
    expect(html).toContain("stop-alarm");
    expect(html).toContain("エラー報告メールを作成");
    expect(html).toContain("019fc3fb-f939-7e30-8175-635f2866b280");
  });
});
