import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCatalog, deterministicCatalogJson, writeCatalog } from "./index.js";

describe("分割イベント設定", () => {
  const temporaryDirectories: string[] = [];
  afterEach(async () => { for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  async function copiedDemo(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "event-pos-catalog-")); temporaryDirectories.push(directory);
    const repository = resolve(import.meta.dirname, "../../..");
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "cf02719", "event-config/demo"], { cwd: repository, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    await Promise.all(files.map(async (file) => {
      const destination = join(directory, file.slice("event-config/demo/".length));
      await mkdir(join(destination, ".."), { recursive: true });
      await writeFile(destination, execFileSync("git", ["show", `cf02719:${file}`], { cwd: repository, encoding: "utf8" }), "utf8");
    }));
    return directory;
  }
  it("demo設定を決定的な既存互換カタログへ統合する", async () => {
    const directory = await copiedDemo();
    const first = deterministicCatalogJson(await buildCatalog(directory));
    const second = deterministicCatalogJson(await buildCatalog(directory));
    expect(first).toBe(second);
    expect(createHash("sha256").update(first).digest("hex")).toBe(createHash("sha256").update(second).digest("hex"));
    const catalog = JSON.parse(first) as { eventId: string; event: unknown; products: unknown[]; quickEntries: unknown[]; staffMembers: unknown[]; productTabs: Array<{ label: string }>; autoDiscountRules: unknown[]; receiptSettings: { commonText?: { footer?: string } } };
    expect(catalog).toMatchObject({ eventId: "demo-event-large", event: { name: "event-pos デモ即売会", seller: { circleName: "毎日" }, locale: { timezone: "Asia/Tokyo" } } });
    expect(catalog.products).toHaveLength(160);
    expect(catalog.products.every((product: { departmentId?: string }) => product.departmentId === "own")).toBe(true);
    expect(catalog.products.filter((product: { tabId?: string }) => product.tabId === "adult")).toHaveLength(20);
    expect(catalog.quickEntries).toHaveLength(2);
    expect(catalog.staffMembers).toHaveLength(4);
    expect(catalog.autoDiscountRules).toHaveLength(1);
    expect(catalog.receiptSettings.commonText?.footer).toBe("ありがとうございました。");
    expect(catalog.productTabs?.map((tab) => tab.label)).toEqual(["野菜", "青果", "鮮魚", "精肉", "惣菜", "ギフト", "本", "成人向"]);
    expect(catalog.quickEntries).toContainEqual({ id: "adult-new", label: "R18新刊 小説A", components: [{ productCode: "T0000141", quantity: 1 }], tabId: "adult" });
  }, 30_000);

  it("commonTextの空文字（footer/returnPolicy）を許可し、書き戻しても保持する", async () => {
    const directory = await copiedDemo();
    const settingsPath = join(directory, "receipt-settings.yaml");
    await writeFile(settingsPath, "schemaVersion: 1\ntemplates: {}\ncommonText:\n  footer: \"\"\n  returnPolicy: \"\"\n  reprintLabel: \"\"\n", "utf8");
    const catalog = await buildCatalog(directory);
    expect(catalog.receiptSettings?.commonText).toEqual({ footer: "", returnPolicy: "", reprintLabel: "" });
    await writeCatalog(directory, catalog);
    const written = await readFile(settingsPath, "utf8");
    expect(written).toMatch(/returnPolicy:\s*""/);
    const reloaded = await buildCatalog(directory);
    expect(reloaded.receiptSettings?.commonText).toEqual({ footer: "", returnPolicy: "", reprintLabel: "" });
  }, 30_000);
  it("参照切れ・重複・未知fieldをファイルと設定パス付きで拒否する", async () => {
    const duplicateDirectory = await copiedDemo();
    const productPath = join(duplicateDirectory, "products", "vegetables.yaml");
    await writeFile(productPath, (await readFile(productPath, "utf8")).replace("productCode: T0000001", "productCode: T0000002"), "utf8");
    await expect(buildCatalog(duplicateDirectory)).rejects.toThrow("products:products: 商品コードが重複しています");

    const unknownDirectory = await copiedDemo();
    const uiPath = join(unknownDirectory, "register-ui.yaml");
    await writeFile(uiPath, `${await readFile(uiPath, "utf8")}\nunknownField: true\n`, "utf8");
    await expect(buildCatalog(unknownDirectory)).rejects.toThrow("register-ui.yaml:$: 未知field unknownField");

    const brokenReferenceDirectory = await copiedDemo();
    const discountPath = join(brokenReferenceDirectory, "discounts.yaml");
    await writeFile(discountPath, (await readFile(discountPath, "utf8")).replace("T0000121", "MISSING"), "utf8");
    await expect(buildCatalog(brokenReferenceDirectory)).rejects.toThrow("discounts.yaml:automaticDiscounts[0].conditions.all[0].productCode: 存在しない商品です");

    const duplicateQuickDirectory = await copiedDemo();
    const quickPath = join(duplicateQuickDirectory, "register-ui.yaml");
    await writeFile(quickPath, (await readFile(quickPath, "utf8")).replace("quickEntryId: adult-new", "quickEntryId: book-pair"), "utf8");
    await expect(buildCatalog(duplicateQuickDirectory)).rejects.toThrow("register-ui.yaml:quickEntries: quickEntryIdが重複しています: book-pair");
  }, 30_000);

  it("商品をすべて削除した設定では古い商品YAMLも削除する", async () => {
    const directory = await copiedDemo();
    const original = await buildCatalog(directory);
    await writeCatalog(directory, { ...original, departments: [], products: [], productTabs: [], quickEntries: [], autoDiscountRules: [] });
    expect((await readdir(join(directory, "products")).catch(() => []))).toEqual([]);
    await expect(buildCatalog(directory)).resolves.toMatchObject({ departments: [], products: [], productTabs: [], quickEntries: [], autoDiscountRules: [] });
  }, 30_000);
});
