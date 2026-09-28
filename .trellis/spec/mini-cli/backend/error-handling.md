# 错误处理（mini-cli）

## die() / DIE symbol（仓库既有模式，cli/src/index.ts）

```ts
const DIE = Symbol.for("mini-cli-die");
function die(msg: string): never {
  console.error(`错误: ${msg}`);
  throw DIE;            // 不是 process.exit！
}
```

- 入口 catch 里识别 `DIE`：置 `process.exitCode = 1` 后**正常返回**。
- 为什么不用 `process.exit()`：undici keep-alive 连接未排空时直接退出会触发
  Windows libuv 断言（exit 127），把真实退出码吞掉。错误路径一律
  `process.exitCode` + 自然退出。
- `die()` 的文案：中文、一行、说清动作建议（如 `未找到 App 目录: <路径>`）。

## 分层

- 参数/前置校验 → `die()`（可预期的用户错误）。
- 网络/协议错误 → try/catch 包装后 `die()` 带上原始信息（不裸抛堆栈给用户）。
- 编程错误（不可能发生的不变量）→ 直接 throw，让堆栈暴露给开发期。

## 禁止

- ❌ `process.exit()` 任何地方（含"成功路径"——成功直接返回即可）。
- ❌ 吞错不置 exitCode（AI agent 靠退出码判断成败）。
- ❌ 英文报错（输出面向用户与 agent，全仓一致用中文）。
