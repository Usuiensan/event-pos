import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { execFileSync } from "node:child_process";

const gitCommit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "未取得"; } })();

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: process.env.POS_API_PROXY_TARGET ?? "http://127.0.0.1:3000", changeOrigin: true, ws: true },
      "/health": { target: process.env.POS_API_PROXY_TARGET ?? "http://127.0.0.1:3000", changeOrigin: true },
      "/training-api": { target: process.env.POS_TRAINING_API_PROXY_TARGET ?? "http://127.0.0.1:3002", changeOrigin: true, ws: true, rewrite: (path) => path.replace(/^\/training-api/, "") },
    },
  },
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(process.env.POS_APP_VERSION ?? "開発版"),
    "import.meta.env.VITE_GIT_COMMIT": JSON.stringify(gitCommit),
  },
});
