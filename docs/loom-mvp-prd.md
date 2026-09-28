# Personal Mini App Host — MVP PRD

## 1. 项目目标

开发一个面向个人桌面小工具的统一宿主。

主要解决三个问题：

1. 日常出现的小工具需求不再各自变成独立、散乱的软件项目；
2. 不同 Mini App 共享常见桌面能力，避免重复开发；
3. 任意外部 Coding Agent 都可以通过统一 CLI 完成创建、开发、运行、调试和维护。

产品不是 IDE，不内置 Coding Agent。

目标开发模式：

```text
需求
 ↓
Codex / Claude Code / GLM / Pi
 ↓
mini create
 ↓
开发业务逻辑
 ↓
mini dev
 ↓
运行 / 日志 / reload
 ↓
Mini App Host
```

最终用户侧：

```text
Host

搜索：
> 连连看
> 文件归档
> 网页资源抓取
> OCR
> 图片处理
```

每个工具根据自己的需求决定采用无 UI、普通窗口、浮窗或 Overlay。

---

# 2. MVP 核心原则

## 2.1 Host 只提供基础设施

Host 不负责具体业务逻辑。

统一提供：

```text
window
hotkey
screen
mouse
keyboard
clipboard
files
process
storage
notification
logging
```

业务逻辑属于 Mini App。

---

## 2.2 不限制 Mini App UI

MVP 支持四种模式：

```text
none
window
floating
overlay
```

暂时不做复杂 Panel 系统。

含义：

### none

无 UI。

例如：

```text
清理临时文件
复制模板
转换剪贴板文本
```

### window

普通独立窗口。

例如：

```text
网页资源抓取器
文件整理
批处理工具
```

### floating

Always-on-top 小窗口。

例如：

```text
连连看运行状态
计时器
游戏辅助
```

### overlay

透明/半透明覆盖层。

例如：

```text
屏幕区域选择
OCR选区
游戏区域标注
```

## 2.3 目标平台

MVP 只支持：

```text
Windows 10 / 11 x64
```

macOS / Linux 不做，跨平台完整支持已在 NON_GOALS。

Windows 上截屏不需要系统级授权，所以第 21 节里的 OS 权限确认在 MVP 平台上基本不会出现。

必须处理：

```text
多显示器
混合 DPI（Per-Monitor DPI 缩放）
```

---

# 3. Mini App 标准结构

一个 App 一个目录：

```text
apps/
└── lianliankan/
    ├── app.yaml
    ├── src/
    │   ├── main.ts
    │   └── ui/
    ├── helpers/
    │   └── solver.py
    ├── assets/
    ├── tests/
    └── README.md
```

MVP 约定：`entry` 只支持 TypeScript / JavaScript。

```text
Python
PowerShell
Native executable
```

以上不作为 entry，统一通过 helper 进程接入（见第 9 节）。

> UI / glue：TypeScript  
> 算法 / 自动化：按任务自由选择，以 helper 方式接入。

---

# 4. Manifest

建议第一版保持非常简单：

```yaml
id: lianliankan
name: 连连看求解器
version: 0.1.0

entry: src/main.ts

ui:
  type: floating
  width: 360
  height: 180

commands:
  - id: solve
    title: 自动求解

  - id: step
    title: 单步求解

  - id: select-region
    title: 重新选择区域

hotkeys:
  solve: Ctrl+Shift+L

permissions:
  - screen.capture
  - mouse.control
  - storage
  - process.spawn
```

第一版不需要复杂 schema。

---

# 5. App Registry

Host 启动时扫描：

```text
/apps/*
```

解析 `app.yaml`。

解析失败的处理：

```text
app.yaml 缺失 / 非法 → 跳过该目录
Launcher 中标记为 broken
mini validate 输出具体原因
错误写入 host.log
```

生成统一 Registry：

```ts
interface MiniApp {
  id: string
  name: string
  version: string

  path: string
  enabled: boolean

  commands: Command[]
  hotkeys: Hotkey[]

  lastRun?: number
}
```

需要支持：

```text
加载
启用
禁用
reload
删除注册
```

不需要做数据库迁移系统。

SQLite 或简单 JSON 都够。

我甚至建议 MVP 用 SQLite，因为后面自然会加入：

```text
运行历史
设置
使用次数
日志索引
```

---

# 6. Launcher

Host 主界面只做一个非常简单的 Command Palette。

例如：

```text
┌────────────────────────────┐
│ > 连连看                    │
├────────────────────────────┤
│ 连连看求解器                │
│   自动求解                  │
│   单步求解                  │
│   重新选择区域              │
└────────────────────────────┘
```

支持：

```text
名称搜索
command 搜索
最近使用
收藏
```

MVP 不需要：

```text
插件市场
复杂推荐
AI 搜索
模糊语义搜索
```

普通 fuzzy search 即可。

---

# 7. Shared SDK

这是整个产品最重要的资产。

建议统一：

```ts
import { host } from "@mini/sdk"
```

两条约定：

- 所有 host.* API 一律 async：内部走 IPC，签名统一返回 Promise。
- `@mini/sdk` 由 Host 注入，App 不自行安装打包，永远与运行中的 Host 同版本。

## 7.1 Clipboard

```ts
host.clipboard.readText()

host.clipboard.writeText(text)
```

---

## 7.2 File

```ts
host.files.read(path)

host.files.write(path, data)

host.files.copy(from, to)

host.files.move(from, to)

host.files.remove(path)

host.files.selectFile()

host.files.selectDirectory()
```

---

## 7.3 Screen

```ts
host.screen.capture()

host.screen.captureRegion(rect)

host.screen.selectRegion()

host.screen.getMonitors()
```

`selectRegion()` 非常值得第一版做。

以后：

```text
OCR
游戏识别
截图
屏幕分析
```

都会用。

坐标约定：

Host 对外统一使用物理像素。

多显示器 + 混合 DPI 的折算在 Host 内部完成，captureRegion / selectRegion / mouse 共用同一坐标系。

---

## 7.4 Mouse

```ts
host.mouse.position()

host.mouse.move(x, y)

host.mouse.click(x, y)

host.mouse.doubleClick(x, y)
```

MVP 不做复杂手势。

---

## 7.5 Keyboard

```ts
host.keyboard.press("F8")

host.keyboard.hotkey(["CTRL", "C"])

host.keyboard.type("hello")
```

---

## 7.6 Global Hotkey

```ts
host.hotkey.register(
  "Ctrl+Shift+L",
  callback
)
```

Host 负责冲突检测。

这是前面测试很多平台时反复缺失的一项，所以建议作为核心能力。

冲突处理：

```text
后注册者失败
报错写入 app log
不抢占已注册热键
```

MVP 范围：热键以 manifest 声明为准，`host.hotkey.register` 保留给运行时动态场景。

---

## 7.7 Notification

```ts
host.notification.show({
  title: "连连看",
  body: "已消除 18 对"
})
```

对应能力清单里的 notification。

验收流程里的 Toast 用它。

---

# 8. Window Service

必须与 Mini App runtime 解耦。

建议：

```ts
host.window.create({
  type: "window" | "floating" | "overlay"
})
```

基本属性：

```text
width
height
x
y

alwaysOnTop
transparent
frameless
resizable
clickThrough
```

第一版不需要做：

```text
Docking
复杂布局
多窗口工作区
窗口动画框架
```

但**允许一个 App 创建额外窗口**最好一开始就留接口。

---

# 9. Process / Helper

这是另一个核心。

API：

```ts
const process = await host.process.spawn({
  command: "python",
  args: ["solver.py"]
})
```

至少支持：

```text
stdin
stdout
stderr
exitCode

kill()
restart()
```

建议统一 JSON Lines：

```json
{"type":"progress","value":0.5}
{"type":"result","data":{}}
{"type":"error","message":"..."}
```

但不要强制 helper 必须使用 JSON。

只是 SDK 给一个 helper utility。

例如：

```ts
host.process.spawnJson(...)
```

---

# 10. Storage

每个 Mini App 独立 namespace。

```ts
host.storage.get("threshold")

host.storage.set("threshold", 0.82)

host.storage.delete("threshold")
```

Host 自动隔离：

```text
lianliankan.*
crawler.*
file-organizer.*
```

Mini App 不需要自己再建配置文件。

---

# 11. Logging

Agent 调试非常依赖这一层。

统一：

```ts
host.log.info()

host.log.warn()

host.log.error()
```

落盘：

```text
logs/
├── host.log
└── apps/
    ├── lianliankan.log
    └── crawler.log
```

必须允许：

```bash
mini logs lianliankan
```

以及：

```bash
mini logs lianliankan --follow
```

stdout/stderr helper 也进入同一个日志流。

---

# 12. Dev CLI

这是 MVP 的最高优先级之一。

CLI 名字暂时叫：

```text
mini
```

至少支持：

```bash
mini create <name>

mini list

mini dev <id>

mini run <id>

mini invoke <id> <command>

mini reload <id>

mini stop <id>

mini logs <id>

mini validate <id>
```

CLI 与 Host 的关系：

Host 启动时开启本地控制通道（localhost + token，地址写入用户目录固定位置），CLI 经它下发命令。

```text
mini list / create / validate / logs    不依赖 Host 运行
mini run / dev / reload / invoke / stop 需要 Host 已启动
```

第二阶段再加：

```bash
mini test

mini build

mini package
```

---

# 13. `mini create`

例如：

```bash
mini create file-organizer
```

生成：

```text
file-organizer/
├── app.yaml
├── package.json
├── src/
│   ├── main.ts
│   └── ui.ts
└── README.md
```

尽量让 coding agent 创建一个新工具以后 **30 秒内就能运行 Hello World**。

---

# 14. Dev Mode

```bash
mini dev lianliankan
```

启动：

```text
watch
↓
build
↓
Host reload
↓
日志输出
```

build 的归属：

每个 App 用 esbuild 打包（entry → dist/main.js），模板里带好构建脚本。

Python helper 没有构建步骤。

理想体验：

```text
Agent 修改代码

200~500ms

App reload
```

View/UI 最好 HMR。

main/runtime 如果不好做完整 HMR，可以：

```text
restart mini app process
```

没必要为了 HMR 把架构搞复杂。

---

# 15. Runtime 隔离

MVP 不需要安全 sandbox。

但是**一个 Mini App 崩溃不能带崩 Host**。

至少：

```text
Host Process

Mini App Runtime Process A

Mini App Runtime Process B
```

MVP 决定采用第一种：

```text
Host Process
Mini App Runtime Process per App
（Electron utilityProcess）
```

理由：

- helper spawn（child_process）需要完整 Node 环境，放 renderer 不自然
- 每个 App 一个进程，崩溃隔离免费拿到
- UI 可选：manifest 有 ui 才创建 BrowserWindow，none 型 App 不创建窗口

App 进程和窗口的关系：

```text
App Runtime Process ←消息→ Host ←消息→ App 的 BrowserWindow
```

Host 中转通用消息即可，不做复杂 RPC。

关键是：

```text
App crash
≠
Host crash
```

崩溃表现：

```text
App 进程退出
Host 标记该 App 为 crashed
Toast 提示 + 写入 app.log
可从 Launcher 或 mini run 重新启动
```

---

# 16. 权限

第一版只做声明，不做复杂审批：

```yaml
permissions:

- screen.capture
- mouse.control
- process.spawn
```

Host 安装时可以简单展示：

```text
连连看要求：

✓ 屏幕截图
✓ 控制鼠标
✓ 启动外部程序

[启用]
```

但本地开发模式可以：

```text
trust-all
```

避免 Coding Agent 每改一次权限都需要人工点确认。

这个教训从 Asyar 的 PoC 已经非常明显。

---

# 17. Mini App 生命周期

统一：

```text
install

load

start

invoke

stop

reload

unload
```

Mini App 可以实现：

```ts
export async function onStart() {}

export async function onStop() {}

export async function invoke(command, args) {}
```

简单工具甚至：

```ts
export async function invoke() {}
```

即可。

---

# 18. 第一版不要实现的东西

明确列入 `NON_GOALS.md`：

```text
Plugin Store

账号系统

云同步

自动更新

AI Chat

内置 Coding Agent

Git 管理

Workflow Designer

Visual Programming

复杂 Sandbox

远程控制

多人协作

插件评分

商业分发

跨平台完整支持
```

否则非常容易跑偏。

---

# 19. 第一个验收 Mini App

用连连看。

不是为了验证算法。

而是验证平台。

这个求解器已经提前开发完成，位置：

```text
D:\Project\lianliankan
```

Python + OpenCV，截图 → 识别 → BFS 求解 → 点击 → 验证的闭环已可运行，带完整单测。

所以第一版的工作不是从零实现，而是迁移。

迁移本身就是最严格的平台验收：

> 如果只需要改接入层，视觉 / 求解代码零改动就能跑，说明 SDK 的切面设计成立。

迁移映射：

```text
mss 截图              → host.screen.captureRegion
Tk 覆盖层框选         → host.screen.selectRegion
pyautogui 点击        → host.mouse.click
solver/ + vision/     → 原样保留，以 helper 进程接入
Tkinter 调试浮窗      → host.window floating 状态窗
config.yaml           → host.storage
print / debug 输出    → host.log
select / step / auto  → manifest commands
```

helper 协议：

Host 截图后，把 PNG（base64）+ 棋盘配置经 stdin JSON Lines 传给 Python helper，helper 返回 tile 坐标与点击路径，点击由 Host 执行。

这样 screen / process / mouse / hotkey / window / storage / log / notification 全部被这一个 App 覆盖。

注意：pyautogui 的角落失效保护随迁移失效，停止手段改为 Launcher 停止按钮 / mini stop。

实现：

```text
Command:
自动求解

Global Hotkey:
Ctrl+Shift+L

Window:
floating status window

Overlay:
select region

Shared API:
screen
mouse
storage
hotkey

Helper:
Python solver
```

验收体验：

```text
Ctrl+Shift+L

↓

截图

↓

调用 Python

↓

求解

↓

鼠标点击

↓

Toast

完成
```

状态浮窗：

```text
连连看

● 运行中

已识别：64
已消除：18

[暂停]
[停止]
```

---

# 20. 第二个验收 Mini App

文件整理器。

验证完全不同的能力：

```text
window
files
directory picker
storage
process
logs
```

例如：

```text
Downloads整理

目录：
D:\Downloads

规则：
[按扩展名 ▼]

☑ Dry Run

[执行]
```

如果这两个 App 都自然，MVP 基本成功。

---

# 21. 验收指标

Host MVP 通过标准：

```text
创建 Mini App
≤ 1 分钟

coding agent 修改
→ 生效
≤ 2 秒

修改代码后
不需要手工操作 Host

Runtime Error
可以通过 CLI 查看

App Crash
不影响 Host

外部 Python Helper
可以完整 start/stop/log

Window / Floating / Overlay
全部可用

Global Hotkey
可注册

Screen / Mouse
可直接调用
```

最重要的一条：

> Coding Agent 从需求到运行结果，除了 OS 必须的权限确认外，不需要操作 Host GUI。

---

# 22. 实施顺序

按依赖关系排，SDK 不预先铺满，按验收 App 的需要渐进补齐：

```text
1. Host 骨架
   Electron 主进程 + 控制通道 + Launcher 空壳

2. Registry + manifest 解析 + mini validate

3. mini create + 模板 + esbuild 构建管线

4. Runtime process + window 服务
   先 window，再 floating / overlay

5. SDK 按需补齐
   storage → log → process → screen → mouse → hotkey → notification

6. 连连看迁移（验收 App 1）

7. 文件整理器（验收 App 2）

8. 对照第 21 节逐条验收
```

---

# 技术方案建议

如果是 MVP，我其实更建议：

```text
Electron
+
TypeScript
+
React/Vue/Svelte任选
+
Node child_process
```

原因不是 Electron 更“高级”，而是开发最快。

Electron 天然就给你：

```text
BrowserWindow
globalShortcut
clipboard
screen
desktopCapturer
shell
child_process
fs
IPC
tray
notification
```

你想要的很多 Shared Services，基本已经在底层现成。

也就是说，你真正要写的是：

```text
SDK wrapper
+
Registry
+
CLI
+
Launcher
```

而不是重新实现 Windows 桌面能力。

如果第一阶段使用 Tauri，很多事情当然也能做，但会更早进入：

```text
Rust Command
Permissions
Plugin
WebView
IPC
```

这些工程工作对验证产品价值没什么帮助。

---

## 开发量大概多少

如果由 coding agent 主导，而且 MVP 不失控，我会粗略估：

| 模块 | 工作量 |
|---|---:|
| Electron Host | 0.5 天 |
| CLI ↔ Host 控制通道 | 0.5 天 |
| Registry + manifest | 0.5 天 |
| App 构建管线（esbuild） | 0.5 天 |
| Launcher | 0.5 天 |
| Dev CLI | 0.5～1 天 |
| Window modes | 0.5～1 天 |
| Desktop SDK | 1 天 |
| Process/helper | 0.5 天 |
| Logging/storage | 0.5 天 |
| Hot reload/dev mode | 0.5～1 天 |
| 文件整理器 PoC | 1 天 |
| 连连看迁移（算法已就绪） | 1～2 天 |

所以：

> **4～6 天能做出能跑的版本，6～8 天达到第 21 节的验收线。**

变化说明：

- 连连看从零 PoC 变成迁移，视觉识别这个最大的 flaky 风险已经提前消化
- 新增 CLI ↔ Host 控制通道、App 构建管线两行，是原估漏掉的真实工作量
- 两者大致相抵

真正做成长期稳定工具可能再投入 1～2 周。

而且这里的大部分代码都非常适合 coding agent：Electron、CLI、manifest、IPC、wrapper 都是高度标准化工程。

---

我还建议给项目加一条最高优先级设计原则：

> **每新增一种 Host API，都先问：“未来至少三个 Mini App 会不会需要它？”**

如果答案不是，就不要放 Host，留在 App 内。

这样可以非常有效地防止这个项目最后又长成一个庞大的自建 Harness。