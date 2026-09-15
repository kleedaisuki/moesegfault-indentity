import { defineConfig } from "vite";

/** Account SPA 构建配置。Build configuration for the Account SPA. */
export default defineConfig({
  build: { sourcemap: true, target: "es2022" },
  server: { port: 5174, strictPort: true },
  preview: { port: 4174, strictPort: true },
});
