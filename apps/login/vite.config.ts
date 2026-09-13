import { defineConfig } from "vite";

/**
 * 为纯静态登录 SPA 提供可复现的构建配置。
 * Provides reproducible build settings for the static login SPA.
 */
export default defineConfig({
  build: {
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
