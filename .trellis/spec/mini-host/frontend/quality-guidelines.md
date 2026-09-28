# 质量守则（ui/）

## 构建管线（必读：file:// + CSP 的来历）

产线链路在 `scripts/build.mjs`：**两遍 Vite 构建**（管理中心 `vite build` → `ui/dist` →
`host/dist/management/`；Launcher `vite build -c vite.config.launcher.ts` →
`ui/dist-launcher` → 改名 index.html → `host/dist/launcher/`。Rollup 的 iife 输出
不支持多入口，所以是两遍而不是一个工程多 HTML）→ 产物 HTML **逐页归一化**
（`normalizeHtml()`：`<script type="module" crossorigin>` 改 `<script defer>`、
去掉 link 的 crossorigin、注入 CSP meta，每页带断言，失败即 throw）→ 打包进 Host。

为什么必须这样（每一环都撞过真实报错）：

- **file:// 下 ESM 模块脚本被 CORS 拦** → 必须经典脚本（iife）。
- **Vite iife 默认把 CSS 内联进 JS，运行时注 `<style>`，撞 CSP style-src** →
  必须 `cssCodeSplit: false` 让 CSS 保持外链文件。
- CSP meta 由 build.mjs 注入，产物内不允许出现外链绝对 URL 资源。
  host-contract 测试有对应 CSP 契约断言（外链 CSS 为相对路径）。

⇒ **改 `vite.config.ts` / `build.mjs` 归一化逻辑 / 引入新依赖（尤其是会注运行时样式的库）
之前，先跑通这条链并打开管理中心页面目检。**

## 回滚路径

`ui/node_modules` 不存在时 `build.mjs` 自动回退旧原生页（`host/src/management/`）。
React 版出现阻断问题时，回滚 = 删 ui/node_modules 重建，不必回退代码。

## 验证

```bash
cd ui && npm run dev      # 浏览器演示模式（mock 数据）调样式/交互
npm run build             # 根目录；确认产物管线通过
npm test                  # host-contract 的 CSP 契约断言
```

目检清单：明暗两态、apps/settings 两页、无桥演示模式可打开。

## 禁止清单

- ❌ 引入 AntD / Element Plus / MUI 等中后台组件库（用户明确否决）。
- ❌ 任何运行时 `<style>` 注入 / CSS-in-JS（撞 CSP style-src）。
- ❌ 组件里直接 `window.__management`（必须经 lib/bridge.ts）。
- ❌ 硬编码颜色（用 index.css 语义 token，保证双主题）。
- ❌ 产物 HTML 出现 module script / crossorigin 属性（归一化会处理，新代码别引入新模式）。
