# 组件守则（ui/）

## 基础件（components/ui/）

- 交互一律先用现成基础件：`button / card / badge / input / switch`（shadcn 风格，
  CVA 变体 + `cn()` 合并类名）。缺变体先扩展现有组件（如 button 加 size/variant），
  再考虑新文件。
- 新基础件进 `components/ui/`，命名与导出风格对齐现文件（`React.forwardRef` +
  `displayName` + variant 枚举）。
- 复合展示件（toast 等）放 `components/`，带 Provider + hook 的组合模式照抄
  `toast.tsx`（Context + useRef 计数 + 定时清理）。

## 页面组件（pages/）

- 页面是取数边界：在页面组件里调 `bridge.*`，子组件只接收 props（保持可演示、可测）。
- 侧栏导航/视图切换在 `App.tsx`；页面不重复实现壳层元素（返回、标题层级）。
- 操作反馈统一走 `useToast`；错误信息先过 `lib/bridge.ts` 的 `errorMessage()`
  （剥掉 Electron `Error invoking remote method 'x':` 包装），error toast 红色。

## 样式

- Tailwind 原子类 + `cn()`；颜色只用 `index.css` 的语义 token
  （`bg-card`、`text-muted-foreground`、`border-border` 等），**禁止硬编码十六进制色**
  ——这是明暗主题双态可用的前提。
- 图标：lucide-react，尺寸 `size-4` / `size-4.5` 一类 token 尺寸。
- 空态/加载态/错误态三态都要有（apps.tsx 是参照实现）。

## 常见错误

- 只在深色下调样式（内置页初始就是深色主题，容易漏看浅色破样式）；提交前两态都过一眼。
- 给基础件传 `className` 时不用 `cn()` 合并（会覆盖掉 variant 类名）。
- 在子组件里直接调 `bridge`（应上提到页面，props 下发）。
