import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    emptyOutDir: true,
    outDir: "dist/renderer",
    sourcemap: true,
  },
  plugins: [react()],
  resolve: {
    alias: {
      "@renderer": resolve(import.meta.dirname, "src/renderer"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
  },
});
