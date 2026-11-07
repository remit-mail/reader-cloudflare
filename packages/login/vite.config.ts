import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  publicDir: resolve(import.meta.dirname, "public"),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "web/index.html"),
        admin: resolve(import.meta.dirname, "web/src/admin.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "admin" ? "admin.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
