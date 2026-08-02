import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

const gitCommit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "未取得"; } })();

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(process.env.POS_APP_VERSION ?? "開発版"),
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(gitCommit),
  },
});
