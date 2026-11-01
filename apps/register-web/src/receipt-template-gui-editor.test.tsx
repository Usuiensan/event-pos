import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReceiptTemplateGuiEditor } from "./receipt-template-gui-editor.js";
import { serializeReceiptTemplateNodes } from "./receipt-template-editor.js";
const V4 = serializeReceiptTemplateNodes([{ kind: "text", text: "{{eventName}}" }, { kind: "row", left: "受付番号", right: "{{publicReference}}" }, { kind: "each", collection: "lines", body: [{ kind: "text", text: "{{name}}" }] }, { kind: "finish", feedLines: 8, cutMode: "partial" }]);
describe("レシートテンプレートGUI", () => { it("部品を表示する", () => { const html = renderToStaticMarkup(<ReceiptTemplateGuiEditor sourceText={V4} assets={[]} disabled={false} onChange={() => undefined} />); expect(html).toContain("かんたん編集"); expect(html).toContain("左右2列"); expect(html).toContain("繰り返し"); expect(html).toContain("仕上げ（カット）"); }); it("読めない本文は直接編集へ誘導する", () => { const html = renderToStaticMarkup(<ReceiptTemplateGuiEditor sourceText="not a template" assets={[]} disabled={false} onChange={() => undefined} />); expect(html).toContain("かんたん編集では開けません"); expect(html).not.toContain("左右2列"); }); });
