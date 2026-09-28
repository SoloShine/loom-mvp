# mini-cli 后端规范（`cli/`）

> `mini` 命令行：外部编码 agent 驱动本平台的唯一入口。esbuild 打包为
> `cli/dist/mini.js`（根 `npm run mini`）。

## 设计边界（PRD pinned 决策）

- **不依赖 Host 也能用**：`list / create / validate / build / logs` 直接读本地
  （apps/ 目录、data/）；`run / dev / reload / invoke / stop / settings / history` 需要
  Host 运行（自动 ensureHost）。新命令先想清楚属于哪一侧。
- CLI 是**薄客户端**：业务规则（manifest 校验、构建参数）以 host 侧代码为唯一事实，
  CLI 只 import 不复制（见 command-pattern）。
- 错误输出面向 AI agent 与人，中文，一行一条结论；退出码非 0 即失败。

## 规范索引

| 文档 | 内容 | 何时读 |
|------|------|--------|
| [目录结构](./directory-structure.md) | src 布局与职责 | 新建文件前 |
| [命令模式](./command-pattern.md) | cmd* 函数、参数解析、create/build 约定 | 加/改命令 |
| [控制通道](./control-channel.md) | runtime.json 发现、client API、undici 纪律 | 联网相关改动 |
| [错误处理](./error-handling.md) | die() / DIE / exitCode 纪律 | 任何改动 |
| [质量守则](./quality-guidelines.md) | 测试、验证、禁止清单 | 改动后 |

## 铁律

1. **禁止 `process.exit()`**（Windows undici 断言，exit 127）——错误路径 `process.exitCode`
   + 抛 `DIE` symbol（见 error-handling）。
2. fetch 一律带 `connection: "close"` 头（keep-alive 复用 + 进程退出 = libuv 断言）。
3. spawn Electron **禁止 windowsHide: true**（ensureHost，见 guides/windows-pitfalls.md）。
4. 命令行/JSON 里的 Windows 路径用正斜杠。
