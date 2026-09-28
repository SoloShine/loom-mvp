# 质量守则（@mini/sdk）

## 验证

```bash
npm run build   # tsc 全仓类型闸门（sdk 无独立构建产物）
npm test        # 改协议/服务时补契约用例（tests/host-contract.test.cjs）
```

端到端：改完跑既有验收 App（连连看/文件整理器）的对应链路，或
`npm run smoke`（S1~S5 覆盖 runtime 生命周期）。改 SDK 后**App 侧无需重装依赖**
——esbuild alias 构建期注入；但已构建的 App 产物要 `mini reload` 重建才带上新 SDK。

## 兼容性纪律

- SDK 注入构建进 App 产物：**旧 App 产物里的旧 SDK + 新 Host** 是常态运行组合，
  所以 host 侧 dispatcher 对旧消息形状要保持兼容（只加不改），协议字段只能新增不能改语义。
  「旧二进制读新数据」是已知不承诺项（见 guides/testing-and-acceptance.md 的快照纪律），
  SDK↔host 协议靠"只增不改"保底。
- 对外类型（Rect/CapturedImage/MonitorInfo）字段只增不改；坐标空间恒为物理像素。

## 禁止清单

- ❌ 同步 API / 隐藏的阻塞调用（全部跨 IPC，必须 async）。
- ❌ SDK 内做业务逻辑或缓存状态（SDK 是薄传输层；订阅表除外）。
- ❌ 监听器异常外抛（必须逐监听器 try/catch）。
- ❌ 引入运行时依赖（SDK 零依赖，打进每个 App 产物）。
- ❌ 在 App 里 `npm install @mini/sdk` 或 bundle 进产物——alias 注入是唯一方式；
  App 代码 import 名固定 `@mini/sdk`（见 cli/src/build.ts 的 alias 配置）。

## 常见错误

- 在窗口渲染侧调用了 node-only 能力（如 `host.process`）——传输层在，但 host 服务
  可能按调用方上下文拒绝；新 API 要明确两种环境的可用性并在 JSDoc 标注。
- 忘记给事件订阅者返回退订函数（`spawnHandle` 三方法 + `hotkey.register` 是参照实现）。
