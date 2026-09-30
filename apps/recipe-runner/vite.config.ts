import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// vite 只做 dev server（npm run dev → app.yaml 的 ui.devUrl 热更）。
// 生产 ui.js 由 mini build 的 esbuild 管线产出，不从这里构建。
// 端口 5176：避开 react 模板缺省 5174（package.json 的 dev 脚本同口）。
export default defineConfig({
  plugins: [react()],
  build: {
    // 产物形态仅与宿主 ui/ 管线对齐（iife）；产线不走这里
    modulePreload: { polyfill: false },
    rollupOptions: { output: { format: "iife", inlineDynamicImports: true } },
  },
});
