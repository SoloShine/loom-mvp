# Windows 平台坑速查（跨包纪律）

> 本项目只在 Windows 10/11 x64 上运行（PRD §2.3）。以下坑全部在本机踩过并修复，
> 属于"不改就会复发"的平台事实，不是建议。相关实现各有守卫代码，改动前先读引用文件。

---

## 坐标系：物理像素是唯一外部空间

- **display.bounds 是 DIP**。多显示器虚拟屏幕坐标系整体按**主屏 scaleFactor** 缩放：
  每屏 bounds 的**原点**必须 ×主屏 scale，**宽高**才 ×该屏自己的 scale。
  原点误用各屏自身 scale 时单屏完全正常，多屏必炸（副屏被算进主屏区间，截屏裁偏、点击不准）。
  统一走 `host/src/main/services/screen.ts` 的 `physicalOrigin` / `physicalRect`，不要自己换算。
- 全部对外 API（SDK `Rect`、`CapturedImage`、`MonitorInfo`）都是物理像素；helper 进程
  （截屏、剪贴板、输入注入）也都在物理空间工作。
- **PowerShell helper 必须声明 DPI 感知**（`SetProcessDpiAwarenessContext(-4)`），
  否则 SetCursorPos/SendInput 全在主屏虚拟化 DIP 空间，点击系统性偏移、y 被钳制。
  见 `host/src/main/services/input-helper.ps1`；迁移/新写 helper 时漏掉过一次。

## 进程与窗口可见性

- **Node spawn 拉起 Electron 绝不能加 `windowsHide: true`**：它会毒化整个进程树的
  窗口可见性（show 事件已触发但 Win32 `IsWindowVisible=false`，窗口永不上屏，托盘/浮窗全"打不开"）。
  `cli/src/client.ts` 的 ensureHost 已按此写；PowerShell/Python 这类控制台 helper 保持 windowsHide 无妨。
- **Electron `globalShortcut.unregister` 是异步释放**：stop→start 立即重注册会失败。
  统一走 `host/src/main/services/hotkeys.ts` 的 `registerWithRetry`，不要裸调 register。
- **全屏游戏窗口处于 Windows 全屏层，比 alwaysOnTop 更高**：凡流程把焦点交出去
  （系统截图工具、角点点击落在游戏上），结束后要把 App 窗口拉回最前
  （dispatcher 的 `screen.selectRegion` 已内置；SDK 侧另有 `host.window.focusSelf()`）。
- **浏览器窗口 `closed` 事件里不能再访问 `win.webContents`**（destroyed 异常），要在关闭前捕获 id。
  历史教训：清理 closed 处理时把 `appByWebContents.set()` 注册行一起删过，导致全部 App 窗口 IPC
  静默失效（按钮全死）。现在 `windows.ts` 有 ownershipDump + "svc ownership FAIL" 守卫日志；
  面板没反应先查 `logs/host.log`。

## PowerShell 与脚本文件

- **PowerShell 5.1 对无 BOM 的 UTF-8 .ps1 按 ANSI/GBK 解码**：中文注释的字节会打乱解析
  （实测吞掉函数内赋值行、变量变 null、`UtcNow -gt $null` 恒真 → 90 秒等待 1.5 秒就"超时"）。
  `scripts/build.mjs` 的 `copyWithBom` 强制给 .ps1 加 BOM——**新增 .ps1 一律要走这条管线**。
  症状是"脚本前半部分莫名失效/行号对不上"时先查 BOM。
- **PowerShell `Win32_Process` 查询会自匹配**：查询命令行里含匹配串，把 powershell 自己
  枚举进结果，造成"进程泄漏"假象。Where 条件必须加 `$_.ProcessId -ne $PID`。
- `taskkill /F` 杀掉的进程退出码是 1，**不要把它当崩溃证据**（冒烟脚本已按此豁免）。

## Electron 截屏与桌面复制

- **desktopCapturer 会吐旧帧**：连续快速抓取时 Windows 桌面复制可能返回缓存帧，
  "画面变了但截屏没变"。`screen.ts` 的 captureDisplay 用双取帧（第一帧预热复制器、取第二帧），
  消费侧（如 runLoop）对"消除后盘面未变小"有旧帧防线。任何"画面变了但截屏没变"的场景先怀疑这个。
- **本机 transparent 窗口不生效**（渲染成不透明灰墙，疑似远程会话/GPU 合成问题）。
  依赖透明窗口的自绘方案整体废弃过一次：选区 = Windows 自带截图工具
  （`ms-screenclip:`，shell.openExternal）+ 剪贴板取图 + `host/dist/locate-region.py`
  模板匹配定位，全程零坐标换算。不要试图恢复透明 overlay 方案。
- 截屏必须在 `openExternal` 弹出截图工具**之前**完成（遮罩会改变屏幕，模板匹配要用弹出前内容）。

## Node / CLI 进程退出

- **undici keep-alive 连接复用后 `process.exit()` 触发 Windows libuv 断言（exit 127）**：
  fetch 加 `connection: close` 头；错误路径用 `process.exitCode` 而不是 `process.exit`
  （CLI 的 `die()` 就是这么写的）。见 `cli/src/client.ts`、`cli/src/index.ts`。

## Shell / 路径纪律

- **Git Bash 命令里写带反斜杠的 Windows 路径会被当成字面文件名**（曾在仓库根留下过
  `appsclipboard-tool`、`nul` 等垃圾）：命令行路径一律用正斜杠或 `cygpath -m/-w` 转换；
  往 JSON / state 里存 Windows 路径也用正斜杠形式（Node 的 fs/path 全都接受，且避免 `\U` 非法转义）。
- **Bash 工具的 cwd 会跨调用持久化，而 hooks 按 cwd 相对解析 `${ZCODE_PROJECT_DIR}`**：
  `cd` 进子目录后，PreToolUse hook 在错误路径找脚本 → 失败 → **后续所有 Bash 调用被整体拒绝**，
  且只能用 Bash 恢复 cwd，形成死锁（2026-09-28 实锁过一次，靠在错误路径放 exit-0 stub 放行后才解开）。
  纪律：每条 Bash 命令要么不开 cwd，要么开头 `cd <仓库根>` 自带回来；绝不在命令结束时把 cwd 留在子目录。

## 诊断工具箱

- `scripts/hotkey-probe.js`：探测组合键是否被系统占用（本机 Ctrl+Shift+L / Ctrl+Alt+L 被占）。
- `scripts/list-windows.ps1`：EnumWindows + IsWindowVisible，核验"窗口看不见"类问题。
  **注意其坐标是 DPI-unaware 虚拟化值（各屏物理 ÷ 该屏 scale），不是物理像素**——
  与 Electron 物理 bounds / a11y 物理值对不上时先换算再比对，别误判回归。
- `host/src/main/services/input-helper.ps1` 的 diag：setCursorPos/sendInput 返回值 + 光标回读，
  诊断鼠标注入链路。
- `logs/host.log` 是第一现场：preload 探针（`mini:preload-loaded`）、ownership 守卫、
  生命周期/异常都插桩在这里。

## Electron 多显示器 DPI 窗口几何

- **跨不同 scale 显示器的一次性 `setBounds` 会把宽高按 targetScale/oldScale 缩放**
  （实测主屏 1.5 → 副屏 1.0 时 480×320 落成 320×213 物理，x/y 不受影响；同屏往返精确）。
  跨屏恢复/摆放几何一律拆「先 `setBounds({x,y})` 移动、窗口落到目标屏后 `setSize(w,h)`」，
  见 `windows.ts` 的 winBounds 恢复分支。
- 窗口几何持久化全程用 Electron DIP（getBounds/setBounds/display.workArea 同空间往返），
  不做物理换算；物理值只出现在对外 API 与 helper。
