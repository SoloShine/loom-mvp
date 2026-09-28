# 控制通道（cli/src/client.ts）

## 发现与鉴权

- Host 启动时把 `http://127.0.0.1:<随机端口>` + 随机 token 写进 `data/runtime.json`；
  CLI 每次调用前读它发现 Host。文件缺失/过期 = Host 未运行。
- **需要 Host 的命令**（run/dev/reload/invoke/stop/settings/history）先 `ping()`，
  不通则 `ensureHost()` 拉起：spawn electron（**禁 windowsHide**）→ 轮询 ping 直到就绪。
  不需要 Host 的命令（list/create/validate/build/logs）绝不触发拉起。

## HTTP 纪律（Windows 实测坑）

- **fetch 一律带 `connection: "close"`**：undici keep-alive 连接复用 + 进程退出 =
  libuv 断言崩溃（exit 127）。client.ts 现有实现已带，新请求方法照抄。
- 错误路径用 `process.exitCode`（见 error-handling.md），不用 `process.exit`。
- token 附在请求头；对 401/拒绝响应给中文一次性错误，不重试轰炸。

## api 方法表

`client.ts` 导出 `api` 对象 + `ping() / ensureHost() / appsDir() / dataDir() / repoRoot()`。
新加 Host 端点：`host/src/main/controlChannel.ts` 加路由 → `client.ts` 加 `api.<method>`
→（如需 CLI 命令）index.ts 加 cmd*。三处同步，契约用例进 `tests/cli-contract.test.cjs`。

## 排障

- Host 侧所有 CLI 请求有日志（`logs/host.log`）；「CLI 说失败但不知道为什么」先对时间戳看 host.log。
- 与真实 Host 并行调试用 smoke 脚本的隔离实例方式（`--user-data-dir=<隔离 data>`），
  不要手动改真实 runtime.json。
