import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Palette build (pass 2 in scripts/build.mjs). Same file:// + strict CSP
// constraints as vite.config.ts (classic IIFE script, external CSS, never
// runtime-injected <style>) — only the entry and outDir differ.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: {
      input: { launcher: path.resolve(__dirname, "launcher.html") },
      output: { format: "iife", inlineDynamicImports: true },
    },
    outDir: "dist-launcher",
    emptyOutDir: true,
  },
});
