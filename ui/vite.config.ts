import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  build: {
    // The Host loads this page over file:// with a strict CSP
    // (script-src 'self'; style-src 'self'): emit a classic IIFE script
    // instead of an ES module (module scripts are CORS-blocked on file://)
    // and keep CSS as an external file, never runtime-injected <style>.
    modulePreload: { polyfill: false },
    cssCodeSplit: false,
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
