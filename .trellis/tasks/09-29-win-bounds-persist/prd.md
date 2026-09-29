# 窗口几何持久化 — P2.1

## Goal

App 窗口的位置/尺寸跨启停持久化：重开恢复上次几何，显示器布局变化时钳制回可见区域。
解决 roadmap 记录的用户痛点——「重开回 manifest 默认尺寸；双屏用户每次拖到副屏都要重拖」。
来源：`docs/post-mvp-plan.md` P2（用户已批准的 roadmap，P2 五项之第一）。

## 确认事实（代码证据）

- 现状无任何 bounds 落盘：`createWindow`（windows.ts:110）不设 x/y（Electron 级联默认位），
  尺寸来自 manifest ui.width/height；`windows.ts` 无任何持久化代码（roadmap 已核实）。
- 持久化底座现成：`state.ts` 的 `AppMeta`（apps: Record<id, AppMeta>）+ `atomicWrite` +
  严格 `validate()` + 损坏旁路（.corrupt-*）+ 较新 schema 只读保护。
  `validate()` 对 AppMeta 是逐字段白名单式校验——新增字段必须同步校验逻辑。
- **`win.destroy()` 不发 `close` 事件**（closeWindow/closeAppWindows/manager 停止路径全用
  destroy）——不能靠关闭钩子存盘，保存必须挂在用户交互事件上。
- Electron `getBounds/setBounds` 与 `screen.getDisplayMatching` 同在 DIP 空间；
  存取往返不经过物理像素换算（windows-pitfalls 的坐标系陷阱只在混用两个空间时触发）。
  但「跨屏 DIP 原点 × 主屏 scale」的坑意味着**手改 host-state 的旧数据不可信**，
  恢复前必须做可见性校验。
- 窗口两类来源：manifest 窗口（`createAppWindow`，launcher/management/manager 调）与
  SDK 动态窗口（dispatcher → `createWindow`）。roadmap 痛点指 manifest 窗口；
  动态窗口是临时性生命周期（App 自管）。
- `windowOptions`：floating/overlay `resizable: false`（尺寸恒等于 manifest 值）。

## Requirements

- **R1 保存**：manifest 窗口在用户移动/缩放结束后落盘（Electron `moved`/`resized` 事件 +
  500ms 防抖，全量 JSON 重写不跟手抖动）；最大化状态下不覆盖已存的正常 bounds；
  写失败仅 warn（沿用 `recordUse` 的容错模式），不影响窗口生命周期。
- **R2 恢复**：createAppWindow 创建窗口时，若 host-state 有该 App 的 winBounds 且
  可见性校验通过 → 应用（`setBounds`，DIP）；部分可见 → 钳制 x/y 使窗口回到最近显示器的
  工作区内（保尺寸）；完全不可见/无记录/校验失败 → 静默回退现状默认（级联位置 + manifest 尺寸）。
- **R3 范围**：只持久化 manifest 窗口（createAppWindow 路径）；SDK 动态窗口行为不变。
- **R4 状态契约**：`AppMeta` 增加可选 `winBounds?: {x,y,width,height}`（DIP 整数）；
  `state.ts` 的 validate 增加对应校验（存在即必须合法——host-state 的既定纪律是
  校验失败整文件旁路，所以校验要和写入端同源，防手改垃圾数据炸整份状态）。
- **R5 测试**：host-contract 增加纯函数用例——bounds 可见性判定/钳制（注入矩形显示器数组）+
  state.ts winBounds 往返与非法值拒绝。
- **R6 文档**：`docs/post-mvp-plan.md` P2 增实施记录；windows-pitfalls 指南补一条
  「窗口几何持久化的坐标空间与可见性纪律」。

## Acceptance Criteria

- [ ] 真机：App 窗口拖到副屏并缩放 → `mini stop` → `mini run` → 窗口在副屏原位恢复
      （截图 + host-state.json 出现 winBounds）。
- [ ] 真机：手改 host-state.json 把 winBounds 挪到不可见区域（如 5000,5000）→ run →
      窗口回退默认位置且 host.log 有说明行（或钳回可见区，按实现二选一，验收与文档一致）。
- [ ] 最小化时停止 App → 重开 → 不恢复成最小化怪尺寸（最大化/最小化状态下不写盘）。
- [ ] SDK 动态窗口（host.window.create）行为不变（代码路径 + 现有测试）。
- [ ] `npm test` 全绿（含新增纯函数与 state 用例）；旧 host-state.json（无 winBounds 字段）
      读入正常（向后兼容）。

## Out of Scope

- 最大化/最小化状态本身的持久化恢复（roadmap 未要求；保存端已避开脏数据）。
- SDK 动态窗口、控制页/管理中心/Launcher 窗口的几何持久化（仅 App manifest 窗口）。
- 多显示器布局变更的主动监听重钳（只在窗口创建时校验一次）。
- P2 其余四项（通知 onClick、会话恢复、截图落盘、内存观测）。

## Open Questions

（无——保存/恢复/钳制策略已在 design.md 定死，验收口径与 R2 一致。）
