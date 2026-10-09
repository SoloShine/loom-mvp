# Loom — Personal Mini App Host

个人桌面小工具的统一宿主（Electron，Windows 10/11）。日常出现的小工具需求不再各自变成散乱的独立项目：不同工具共享常见桌面能力，一个 Host 统一管理生命周期、热键、日志与窗口。

工具生产有两条路径：

```text
① 代码型 Mini App —— 面向 Coding Agent / 开发者
   需求 → agent → mini create → TypeScript 业务逻辑 → mini dev → 运行

② 声明型 Recipe —— 面向「组合已有动作」的简单需求
   一段 YAML（steps 列表）→ 解释执行 → 改完即生效，无 build 无 reload
```

设计文档见 [`docs/loom-mvp-prd.md`](docs/loom-mvp-prd.md)，路线与实施记录见 [`docs/post-mvp-plan.md`](docs/post-mvp-plan.md)。

## Recipe：三十秒理解它

```yaml
# apps/recipe-runner/recipes/clipboard-markdown-links.yaml（成品节选）
# 「标题 + URL」行 → 一键整批转 Markdown 链接写回剪贴板；Ctrl+Alt+L 静默即走
id: clipboard-markdown-links
name: 剪贴板转 Markdown 链接
hotkey: Ctrl+Alt+L

steps:
  - id: read
    action: clipboard.readText
    out: text
  - id: count
    action: text.match
    args:
      text: "{{steps.read.text}}"
      pattern: '^\S[^\n]*?\s+https?://\S+$'
      flags: "gm"
      all: true
    out: hits
  - id: convert
    action: text.replace
    args:
      text: "{{steps.read.text}}"
      pattern: '^(.+?)[ \t]+(https?://\S+)[ \t]*$'
      flags: "gm"
      replacement: '[$1]($2)'
    out: md
  - id: write
    action: clipboard.writeText
    args: { text: "{{steps.convert.md}}" }
  - id: notify
    action: notification.show
    args:
      title: 剪贴板已转 Markdown
      body: '已把 {{steps.count.hits.length}} 行转成链接'
```

一个 recipe 就是一条**有限流**：顺序 + 条件 + 循环，错误即停。支持 dry-run（变更类动作跳过并记录「将做什么」）、结构化运行轨迹、从第 N 步重跑、参数表单（取值链 override > preset > last-used > default）。词表 = host 桌面原语 + 文本/HTTP/JS 工具 + 交互步骤（`ui.ask/confirm/menu`）。

**分界原则**：组合已有动作、流程偶尔等人 → recipe；结构复杂度或交互密度超限 → 升格为代码 App（判定细则见 [`.trellis/spec/guides/recipe-vs-app-boundary.md`](.trellis/spec/guides/recipe-vs-app-boundary.md)）。完整语法与动作词表见 [`apps/recipe-runner/README.md`](apps/recipe-runner/README.md)。

## 结构

```text
host/   Electron 主进程：Registry、Runtime（每 App 一个 utilityProcess）、全部 host.* 服务、Launcher、控制通道
sdk/    @mini/sdk：App 使用的统一 API（构建时由 CLI alias 注入，App 无需安装）
cli/    mini 命令行：create / build / dev / run / stop / reload / invoke / logs / validate
apps/   Mini App 目录（一个 App 一个目录，app.yaml 描述；recipe-runner 内含 recipes/）
data/   运行数据：logs / storage / runtime.json（控制通道地址+token，gitignored）
```

## 能力面（host.* 服务）

App 经 SDK 调用，权限在 manifest 声明：

| 域 | 能力 |
|---|---|
| window | 四种 UI 形态：none / window / floating / overlay，几何持久化 |
| hotkey | 全局热键（manifest 静态 + 运行时动态注册，先到先得） |
| screen | 截屏 / 选区 / 多显示器信息（物理像素坐标，混合 DPI 已折算） |
| mouse / keyboard | 位置 / 移动 / 点击 / 等待点击；按键 / 组合键 / 输入文本 |
| clipboard / files | 读写剪贴板；文件读写复制移动、目录/文件选择器 |
| process | helper 进程 spawn（任意语言，JSON Lines 友好） |
| notification / storage / log | 通知（可点选回调）；App 命名空间 KV 存储；分级日志 |

## 内置 App

| App | 说明 |
|---|---|
| `recipe-runner` | 配方执行器——本仓特色，声明式 recipe 层（React 管理窗 + 轨迹叠加视图） |
| `lianliankan` | 连连看求解器——首个验收 App：截图→识别→BFS 求解→点击闭环（Python helper 原样接入） |
| `file-organizer` | 下载目录整理器——规则整理 + Dry Run + 去向通知 |
| `clipboard-tool` | 剪贴板工具 |
| `screen-inspector` | 屏幕信息检查器（多屏 / DPI / 截图） |
| `hello` | 平台接线自检样例（host.* 全服务冒烟） |

## 快速开始

```bash
npm install
npm run build          # 构建 host + cli

# 代码型 App（agent/开发者路径）
npm run mini -- create hello        # 脚手架（--template minimal|react）
npm run mini -- run hello           # 自动拉起 Host + 构建并运行
npm run mini -- invoke hello ping
npm run mini -- logs hello --follow
npm run mini -- dev hello           # watch + 自动 reload

# Recipe（声明式路径）
npm run mini -- invoke recipe-runner check          # 校验全部 recipe
npm run mini -- invoke recipe-runner run --args '{"recipe":"clipboard-notify"}'
```

Launcher：托盘图标或 `Ctrl+Shift+M`。Host 未运行时，需要 Host 的 CLI 命令会自动拉起它。

## 开发与测试

```bash
npm test               # host / cli / sdk 契约测试（49 项）
npm run smoke          # Host 冒烟
cd apps/recipe-runner && npm test   # recipe 引擎 + 动作层单测（101 项）
```

App 使用 `mini dev` 热更（main 侧 rebuild + reload，UI 侧可选 Vite HMR，`ui.devUrl`）。

## 边界与现状

- 目标平台 Windows 10/11 x64（多显示器 + 混合 DPI 已处理）；跨平台、插件商店、云同步等在 PRD §18 的 NON_GOALS 清单中。
- App 与 recipe 均为**本地可信内容**，不做沙箱（PRD §16 信任模型）。
- MVP 已按 [`docs/acceptance-record.md`](docs/acceptance-record.md) 验收（v0.1.0-mvp）；recipe 层为 P3 首项产物。

## 最重要的一条验收标准

> Coding Agent 从需求到运行结果，除了 OS 必须的权限确认外，不需要操作 Host GUI。

## License

[MIT](LICENSE)
