import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildCatalog, deterministicCatalogJson } from "./index.js";

const [command, directory, ...rest] = process.argv.slice(2);
if ((command !== "validate" && command !== "build") || !directory) throw new Error("使い方: pnpm catalog <validate|build> <event-config> [--out <path>]");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const inputDirectory = resolve(invocationDirectory, directory);
const catalog = await buildCatalog(inputDirectory);
if (command === "validate") { console.log(`検証成功: ${inputDirectory}`); }
else { const outIndex = rest.indexOf("--out"); const output = outIndex >= 0 ? rest[outIndex + 1] : undefined; if (!output || rest.length !== 2) throw new Error("buildには --out <path> が必要です"); const target = resolve(invocationDirectory, output); await mkdir(dirname(target), { recursive: true }); await writeFile(target, deterministicCatalogJson(catalog), "utf8"); console.log(`生成完了: ${target}`); }
