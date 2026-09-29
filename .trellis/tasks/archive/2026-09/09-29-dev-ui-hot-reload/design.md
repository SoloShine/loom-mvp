# 技术设计 — dev 模式 UI 热更新（ui.devUrl）

## 核心机制：创建时探测，同步签名不变

`createWindow`（windows.ts）保持同步签名（调用方 5 处均同步取 windowId，不做涟漪），
加载决策移入内部的 detached promise：

```
createWindow(appId, type, w, h, title?)
├─ new BrowserWindow(...windowOptions)      # show:false，探测期间不上屏
├─ trackWindow(appId, windowId, win)        # 归属注册保持同步（closed 语义不变）
├─ void (async () => {
│    const devUrl = devUrlOf(appId)          # 读 manifest（见下）
│    if (devUrl && await reachable(devUrl))  # fetch + AbortSignal.timeout(400)，任何响应即可达
│      await win.loadURL(appendQuery(devUrl, __miniWindowId))
│    else {
│      if (devUrl) logHost("info", `devUrl 不可达,回退产物 (app=${appId})`)
│      await win.loadFile(ensureShellHtml(app), { query: { __miniWindowId: windowId } })
│    }
│  })()
└─ win.once("ready-to-show", () => win.show()); return windowId
```

- **manifest 来源**：`createWindow` 现在只拿 appId 字符串，devUrl 从 registry 取
  （`registry.get(appId)?.manifest.ui.devUrl`——SDK 动态窗口同享 App 清单的 devUrl，语义一致）。
  取不到清单（如 registry 未含）→ 按无 devUrl 处理。
- `appendQuery`：URL 已带 query 时用 `URL` 对象正确拼接，避免手写 `?`/`&` 判断。
- 探测判定：**收到任何 HTTP 响应即可达**（不判 `res.ok`）——SPA dev server 对部分路径回 404
  不影响页面加载；连接拒绝/超时 = 不可达。
- 失败兜底：loadURL 本身 reject（dev server 在探测后、加载前死掉）→ catch 回退 loadFile 产物 +
  日志。窗口永不白屏。

## manifest 契约（manifest.ts）

```ts
export interface UiDef {
  type: "none" | "window" | "floating" | "overlay";
  width?: number;
  height?: number;
  /** dev 模式 UI 热更:dev server 可达时窗口 loadURL 此地址,否则回退产物 */
  devUrl?: string;
}
```

校验（parseManifest 内）：`typeof raw.ui.devUrl === "string"` 时必须
`http://` 或 `https://` 前缀，否则 push 错误（`ui.devUrl 非法(需 http/https 地址): ${value}`）。
非字符串但存在 → 同样报错。不强制 localhost（信任模型与 App 代码一致；本机开发是推荐用法不是约束）。

## preload / Launcher 清理（P1.1 遗留）

- `host/src/preload/launcher.ts`：onError/onRefresh 改为返回退订函数
  `() => ipcRenderer.removeListener(channel, handler)`（handler 引用保留以便移除）。
- `ui/src/types.ts` `LauncherBridge`：onError/onRefresh 返回 `() => void`。
- `ui/src/launcher/LauncherApp.tsx`：两个订阅 effect 返回桥的退订函数（useEffect cleanup）。
- 不动 management 桥（无订阅面）。

## CLI（cli/src/index.ts cmdDev）

启动提示一行（读清单）：

```
dev 提示: ui.devUrl=http://localhost:5173(dev server 未起时窗口回退产物;起/停后重开窗口切换)
```

CLI 不探测、不代管 dev server 生命周期（roadmap 边界）。reload 语义不变。

## 契约测试（tests/host-contract.test.cjs）

- manifest：合法 devUrl 通过；`ftp://x` / 数字类型 → `ok:false` 且错误含字段名（esbuild 编译 manifest.ts 直接测）。
- 加载决策：把「探测 + 目标选择」抽成可导出的纯度较高的函数
  `resolveDevTarget(devUrl: string|undefined, probe?: (url)=>Promise<boolean>): Promise<"dev"|"artifact">`
  （windows.ts 导出，默认 probe 用 fetch，测试注入假 probe）——测试覆盖
  声明+可达 / 声明+不可达 / 未声明 三分支，避免真实网络依赖。
- 现有用例零改动。

## 信任与安全评估

- dev 页面 = App 作者自己的代码（与打包产物同信任级）；`contextIsolation: true` 保持，
  preload 桥在 http 源下照常注入；归属表在创建时注册、与源无关。
- 不放宽任何 controlPage/launcher sender 校验（App 窗口本就不走该机制）。
- devUrl 探测只在窗口创建时发生，无轮询、无新增常驻网络行为。

## 兼容与回滚

- 未声明 devUrl 的 App：代码路径与现状逐字节一致（探测分支根本不进入）。
- git 回滚即可整体退场；manifest 新字段向后兼容（旧 Host 读新清单忽略 devUrl——
  「旧二进制读新数据」本就是不承诺项，tag 纪律兜底）。

## 取舍记录

| 取舍 | 选择 | 理由 |
|------|------|------|
| 探测位置 | host 窗口创建时 | roadmap 措辞「mini dev 检测」实为期望行为；加载决策只能在 host；CLI 只留提示 |
| 同步签名 + detached promise | 保持 | 5 个调用方零改动；窗口 show:false 期间探测无可见副作用 |
| 任何响应即可达 | 不判 res.ok | 避免 SPA 404 误回退；dev server 存在即语义成立 |
| 验收载体 | 临时 demo App + scratch vite | 仓库无 React 模板（P1.3）；不留一次性脚手架进 apps/ |
| devUrl 提取 | registry.get(appId) | createWindow 无 manifest 入参；动态窗口与主窗口语义统一 |
