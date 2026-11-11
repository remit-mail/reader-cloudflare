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
      // Rollup's default of 1000 open files exhausts the 1024 descriptor limit on Workers Builds.
      maxParallelFileOps: 20,
      input: {
        main: resolve(import.meta.dirname, "web/index.html"),
        admin: resolve(import.meta.dirname, "web/src/admin.ts"),
        login: resolve(import.meta.dirname, "web/src/styles/login.css"),
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "admin" ? "admin.js" : "assets/[name]-[hash].js",
        assetFileNames: (asset) =>
          asset.names.includes("login.css") ? "login.css" : "assets/[name]-[hash][extname]",
      },
    },
  },
});
