# 技术设计 — 窗口几何持久化

## 数据契约（state.ts）

```ts
export interface WinBounds { x: number; y: number; width: number; height: number }
export interface AppMeta {
  …现有字段…
  /** 上次正常状态的窗口几何(DIP)。最大化/最小化期间不写入。 */
  winBounds?: WinBounds;
}
```

- `validate()`：`winBounds` 存在时必须是 4 个有限数且 `width/height ≥ 1`、
  `x/y` 为安全整数（宽松形状校验，越界值由消费端钳制——host-state 的纪律是
  校验失败整文件旁路，所以这里只挡「结构性垃圾」，不挡「布局过期的合法值」）。
- 旧文件无此字段 → optional 直读，schemaVersion 不动（旧 host 读新文件也不会拒——
  其 validate 不查未知键；「旧二进制读新数据」按既定纪律不承诺，此处天然兼容）。
- 新 API：`setWinBounds(id, bounds)`（try/catch warn，照 `recordUse` 模式）；
  读取走现有 `meta(id)?.winBounds`。

## 保存路径（windows.ts）

- `createWindow` 加内部参数 `persist: boolean`（`createAppWindow` 传 true，dispatcher
  的 SDK 动态窗口传 false）。
- persist 窗口挂事件：`win.on("moved", scheduleSave)` + `win.on("resized", scheduleSave)`；
  `scheduleSave` = 500ms 防抖 → 读取 `win.getBounds()` → `state.setWinBounds(appId, bounds)`。
  **跳过最大化/最小化**：`win.isMaximized() || win.isMinimized()` 时直接丢弃本次保存
  （getBounds 在最大化时返回铺满值，写进去会污染下次恢复）。
- 不挂 close/destroy 钩子（destroy 不发 close；最后一次交互已在防抖窗口内落盘）。
- 防抖 timer 按 appId 存 Map，窗口销毁时清理（closed 回调里 clear + 兜底
  isDestroyed 检查——closed 事件里禁碰 webContents，但 getBounds 前必须 isDestroyed）。

## 恢复路径（windows.ts + 纯函数模块）

新纯模块 `host/src/main/services/winBounds.ts`（electron-free，可契约测试）：

```ts
sanitizeRestoredBounds(
  saved: WinBounds,
  displays: { workArea: Rect }[],   // Electron screen.getDisplayMatching 的调用方注入
): WinBounds | null
```

规则（按序）：
1. 结构非法 → null（回退默认）。
2. 计算与各 display.workArea 的相交面积，取最大者：
   - 零相交（显示器拔了/坐标完全过期）→ null；
   - 有相交 → 钳制 x/y 使「窗口至少 64×48 可见」且尽量整体落回该 workArea
     （clamp(x, workArea.x - width + 64, workArea.right - 64)，y 同理）；
     宽高本身钳到不超 workArea（防手改超大值）。
3. 返回钳制后的 bounds；调用方拿到 null 就走现状默认。

`createWindow`（persist 分支）：窗口创建后、`ready-to-show` 前应用：

```ts
const saved = state.meta(appId)?.winBounds;
const displays = screen.getAllDisplays().map(d => ({ workArea: d.workArea }));
const fixed = saved ? sanitizeRestoredBounds(saved, displays) : null;
if (fixed) win.setBounds(fixed);
if (saved && !fixed) logHost("info", `winBounds 不可见,回退默认位置 (app=${appId})`);
```

- DIP 空间存取往返：保存用 getBounds、恢复用 setBounds、可见性用 display.workArea——
  三者同空间（Electron DIP），**不做任何物理像素换算**（windows-pitfalls 的
  「原点 × 主屏 scale」陷阱只存在于混用物理空间时；此处全程不混）。
- 手改 host-state 的过期坐标（如 5000,5000）被第 2 步拦截 → 回退默认 + 日志，
  与验收口径一致（回退而非硬钳回，行为可预测且日志可查）。

## 范围与不变量

- SDK 动态窗口（persist=false）零行为变化；controlPage/Launcher/管理中心窗口不涉及。
- floating/overlay `resizable:false`：getBounds 的宽高恒等于 manifest 值，恢复全量
  bounds 对尺寸是无操作，位置照常恢复。
- 现有窗口生命周期（hide/focus/close/stop）全部不感知此特性（纯旁路读写 state）。

## 测试（tests/host-contract.test.cjs）

1. `sanitizeRestoredBounds` 纯函数：完全可见原样返回；部分越界钳回；零相交 null；
   非法结构 null；超大宽高钳到 workArea（注入矩形数组，无 electron 依赖，
   esbuild→cjs 模式加载 winBounds.ts）。
2. `state.ts`：winBounds 合法值写读往返（setWinBounds + meta）；非法值（字符串坐标/
   负宽）使 validate 拒绝 → 损坏旁路路径（现有 .corrupt 测试模式复用）。

## 回滚

git revert 即整体退场；winBounds 字段留在 host-state.json 中对旧代码不可见（可选字段）。
风险文件：`state.ts`（validate 变更——只增不改既有字段校验）、`windows.ts`
（persist=false 主路径不变）。
