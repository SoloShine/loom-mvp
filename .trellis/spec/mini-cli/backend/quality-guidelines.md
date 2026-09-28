# 质量守则（mini-cli）

## 验证

```bash
npm run build   # 根构建管线（含 cli esbuild 打包 + tsc）
npm test        # tests/cli-contract.test.cjs 是 CLI 契约用例的家
npm run accept  # mini create 耗时在 PRD §21 有硬指标（30 秒内），动 create/打包后必跑
```

手动冒烟：`mini list`（无 Host 路径）、`mini run <id>` + `mini invoke <id> <command>`
（有 Host 路径）、`mini validate <id>` 对一个故意写坏的 app.yaml。

## 契约测试写法

`tests/cli-contract.test.cjs`：node:test + 现场编译 cli 源（同 host-contract 的
esbuild→cjs→require 模式），需要本地文件态的用例用临时目录。
新增命令/端点的往返行为在这里落用例。

## 禁止清单

- ❌ `process.exit()`（一律 die() + process.exitCode）。
- ❌ fetch 不带 `connection: "close"`。
- ❌ spawn electron 加 `windowsHide: true`。
- ❌ 在 CLI 侧重写 manifest/路径/构建规则（import host 唯一事实）。
- ❌ 引入参数解析/CLI 框架依赖（argFlag + 手写分发足够）。
- ❌ 输出英文或长堆栈给用户（die() 中文一行）。

## 平台坑

见 [guides/windows-pitfalls.md](../../guides/windows-pitfalls.md)：路径反斜杠、
undici 退出断言、windowsHide 毒化——CLI 侧三个坑全踩过，改动前过一遍。
