import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "web"),
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      treeshake: { moduleSideEffects: (id) => !id.includes("/node_modules/@remit/ui/dist/") },
      input: {
        main: resolve(import.meta.dirname, "web/index.html"),
        admin: resolve(import.meta.dirname, "web/src/admin.ts"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "admin" ? "admin.js" : "assets/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.includes("admin.css") ? "login.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
