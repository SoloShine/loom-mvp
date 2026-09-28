# mini-host 前端规范（`ui/` — React 管理中心）

> 覆盖仓库根目录 `ui/`（独立 Vite 工程，构建产物进入 `host/dist/management/`）。
> Launcher 目前仍是原生页（`host/src/launcher/`），其 React 化是 roadmap P1.1
> （`docs/post-mvp-plan.md`），迁移时必须复用本文档描述的全部管线约定。

## 技术栈（pinned，勿换）

React 19 + Vite 7 + Tailwind v4 + shadcn 风格自持组件（`components/ui/`）+
lucide-react 图标。风格基调 Linear/Vercel/Raycast：小字号（根字号 13px）、低对比描边、
克制留白。**用户明确否决 AntD / Element Plus 类中后台组件库**（讨论定调），不要引入。

## 规范索引

| 文档 | 内容 | 何时读 |
|------|------|--------|
| [目录结构](./directory-structure.md) | src 布局、lib 职责、@/ alias | 新建文件前 |
| [组件守则](./component-guidelines.md) | ui/ 基础件、页面组件、图标、cn() | 写任何组件 |
| [状态与数据](./state-management.md) | bridge / 演示模式 / 类型契约 / 主题 | 取数、状态、主题相关 |
| [质量守则](./quality-guidelines.md) | **构建管线（IIFE + CSP）**、验证、禁止清单 | 改构建/依赖前必读 |

## 铁律

1. **file:// + CSP 环境是硬约束**：产物必须是经典脚本 + 外链 CSS（`cssCodeSplit: false`
   + `format: "iife"`），见 quality-guidelines。改 `vite.config.ts` 或 `scripts/build.mjs`
   的归一化逻辑前先读懂这条链。
2. **无桥环境必须可用**：所有取数走 `lib/bridge.ts`，桥缺失自动落演示数据
   （`mocks.ts`）——纯浏览器开发也要能看全页面。
3. **明暗主题切换是验收项**（用户硬性要求）：任何新页面/组件都在两种主题下检查；
   注意 Electron 内置页 `prefers-color-scheme` 初始就是深色。
4. ui/ 的 npm 依赖安装要加 `--registry=https://registry.npmmirror.com`（主源会吐损坏 tarball）。
