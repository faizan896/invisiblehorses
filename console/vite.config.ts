import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "/app/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        workspace: fileURLToPath(new URL("./index.html", import.meta.url)),
        review: fileURLToPath(new URL("./review/index.html", import.meta.url)),
      },
    },
  },
  server: { port: 8788, proxy: { "/console-api": "http://127.0.0.1:8787" } },
});
