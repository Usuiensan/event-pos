// 現行demo catalogから、レビュー可能な分割YAMLの初期一式を作る一回限りの移行補助。
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "../packages/catalog-config/node_modules/yaml/dist/index.js";

const source = await readFile(new URL("../apps/register-web/src/demo-catalog.ts", import.meta.url), "utf8");
const match = source.match(/const groups: DemoGroup\[\] = ([\s\S]*?);\r?\n\r?\nlet sequence/);
if (!match?.[1]) throw new Error("demo groupsを読み取れません");
const groups = Function(`return ${match[1]};`)();
const root = new URL("../event-config/demo/products/", import.meta.url);
await rm(root, { recursive: true, force: true }); await mkdir(root, { recursive: true });
let sequence = 1;
for (const group of groups) {
  const products = group.items.map(([name, priceYen], index) => {
    const number = String(sequence++).padStart(7, "0");
    return { productCode: `T${number}`, name, shortName: name, priceYen, tax: { category: "tax_included", ratePercent: group.taxRate }, ageRestriction: { category: group.ageCheck ? "r18" : "general" }, inventory: { openingQuantity: 0, allowNegative: true }, display: { tabId: group.id, buttonLabel: name, sortOrder: (index + 1) * 10, color: group.color }, sales: { enabled: true } };
  });
  await writeFile(new URL(`${group.id}.yaml`, root), stringify({ schemaVersion: 1, departmentId: "own", products }), "utf8");
}
await writeFile(new URL("../event-config/demo/register-ui.yaml", import.meta.url), stringify({ schemaVersion: 1, tabs: groups.map((group, index) => ({ tabId: group.id, label: group.label, sortOrder: (index + 1) * 10, color: group.color })), quickEntries: [{ quickEntryId: "book-pair", label: "新刊 小説A+B", tabId: "books", components: [{ productCode: "T0000121", quantity: 1 }, { productCode: "T0000122", quantity: 1 }] }, { quickEntryId: "adult-new", label: "R18新刊 小説A", tabId: "adult", components: [{ productCode: "T0000141", quantity: 1 }] }], customerDisplay: { welcome: { circleName: "event-pos テストサークル", space: "東A-01a", message: "いらっしゃいませ\n新刊・既刊を頒布しています" } } }), "utf8");
