import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/app/",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  server: { port: 8788, proxy: { "/console-api": "http://127.0.0.1:8787" } },
});
