# 测试与验收纪律

> 本仓库的质量闸门固定为三条命令 + 一套数据纪律。改完代码报"完成"之前必须跑过
> 对应闸门；契约变更（manifest 字段、IPC 消息、SDK API、状态文件）必须同步补契约测试。

---

## 三条命令

| 命令 | 内容 | 证据落点 |
|------|------|----------|
| `npm test` | `node --test tests/*.test.cjs`，全部单测（29 项基线） | stdout |
| `npm run smoke` | `scripts/smoke-host.cjs` 五用例：S1 启停 / S2 崩溃隔离 / S3 猝死恢复 / S4 stop 超时强杀 / S5 产物重建 | `data/smoke/run-*` |
| `npm run accept` | `scripts/acceptance-timing.cjs`：`mini create` 耗时、edit→live 延迟、回滚演练 | `docs/acceptance-record.md` |

类型检查用 `npm run build`（tsc + esbuild 全管线）确认无类型错误。

## 单测写法（仓库既有模式）

- 测试是根目录 `tests/*.test.cjs`，用 `node:test` + `node:assert/strict`，**不是**各包自带测试框架。
- TypeScript 源无法直接 require：用 esbuild 现场编译成 cjs 到临时目录再加载，
  `external: ["electron"]`。参考 `tests/host-contract.test.cjs` 的 `load()` helper。
- 需要隔离数据目录时设 `MINI_DATA_DIR`（`host/src/main/config.ts` 的 paths 全部吃这个环境变量）；
  测试内起子进程跑断言的写法也见 host-contract 的 history 恢复用例。
- 纯逻辑（如 apps/file-organizer 的 `src/rules.ts`）从宿主逻辑抽出来直接测；
  需要真实文件系统的用例用临时目录，finally 里清理。

## 数据纪律

- `data/` 已 gitignore：**回归夹具（如 data/board-*.png）只存在于磁盘，不在版本库里**。
  删数据目录、换机器前先想清楚这些夹具会丢。
- 冒烟/验收证据写进 `data/smoke/`，同样不入库；结论性的记录回写到
  `docs/acceptance-record.md`（终稿对应 tag `v0.1.0-mvp`，PRD §21 十项指标）。
- **快照纪律**：做有风险的主进程/数据格式改动前，把 data/ 打包到
  `D:/Project/loom-mvp-backups/data-<tag>.zip`，并在 git 上打 tag。
  旧二进制读新数据的兼容性**不做承诺**（已知未验证项），靠 tag + 快照兜底。

## 手动验收

- GUI 侧的手动验收清单沉淀在 `docs/manual-test-checklist.md`（与 PRD §21 逐条对照）。
  涉及窗口、托盘、热键、截屏交互的改动，自动测试覆盖不到，按清单人肉回归。
- 改 `host/` 主进程代码后要**重启 Host** 才生效（dev 亦然）；`mini reload` 只重建 App 产物。
