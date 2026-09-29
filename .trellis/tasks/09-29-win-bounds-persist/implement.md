# 执行计划 — 窗口几何持久化

前置：无。

## 步骤 1：状态契约（state.ts）

- [ ] `WinBounds` 接口 + `AppMeta.winBounds?`；`validate()` 增加宽松形状校验
      （存在时 4 有限数、宽高 ≥1）；`setWinBounds(id, bounds)`（try/catch warn）
- 验证：`npm run build`；现有 state 测试（tests/state.test.cjs）不回归

## 步骤 2：纯函数模块（services/winBounds.ts）

- [ ] `sanitizeRestoredBounds(saved, displays)`：结构校验 → 相交判定 → 钳制 →
      null/ bounds（规则见 design.md，全部纯计算无 electron 导入）
- 验证：`npm run build`

## 步骤 3：windows.ts 接线

- [ ] `createWindow` 加 `persist` 内部参数（createAppWindow=true，dispatcher=false）；
      恢复分支（meta → sanitize → setBounds / 回退日志）；
      保存分支（moved/resized + 500ms 防抖 + 最大化/最小化跳过 + timer 清理）
- 验证：`npm run build`；`npm run smoke`（S1~S5 生命周期无回归）

## 步骤 4：契约测试

- [ ] host-contract：sanitizeRestoredBounds 五分支（原样/钳回/零相交/非法/超大）；
      state winBounds 往返 + 非法值拒绝
- 验证：`npm test` 全绿（41 + 新增）

## 步骤 5：真机验收 ✅ 2026-09-29 完成(主会话 CUA 实测)

- [x] demo：`mini create demo-bounds --ui window` → run → CUA 把窗口拖到副屏并缩放
      → 等 ≥1s（防抖）→ 查 host-state.json 出现 winBounds → stop → run →
      截图确认副屏原位恢复
- [x] 过期坐标：手改 host-state.json 的 winBounds 到 (5000,5000) → run →
      窗口回退默认位 + host.log 说明行
- [x] 最小化后 stop → run → 尺寸正常（非铺满怪值）
- [x] hello（无 persist 差异的既有 App）回归；`npm run smoke` 全绿
- [x] 清理 demo-bounds；roadmap P2 实施记录；windows-pitfalls 补「几何持久化坐标纪律」条目
- 风险文件：`host/src/main/state.ts`（validate 只增不改）、
  `host/src/main/services/windows.ts`（persist=false 路径逐字不变）。

## 回滚点

- 步骤 1-4 逐文件 git checkout；winBounds 字段留在旧 host-state.json 对旧代码不可见。
- 步骤 5 demo 删目录即净。

## task.py start 前检查

- [x] implement.jsonl / check.jsonl 已填真实条目
- [x] prd.md 收敛通过（无 Open Question、无重复段落）
- [x] 用户已明确批准本规划摘要

## 实施记录（2026-09-29 完成）

- 实现（trellis-implement）+ 检查（trellis-check PASS，sanitize 六断言数学独立复算全对）：
  44/44 测试、smoke 5/5、build 绿。
- 验收期发现并修复的两个真问题 + 一个观测器教训：
  1. **create→立即 run 竞态（既有 bug）**：controlChannel 的 GET/POST 预检直接查 registry
     缓存，watcher 未扫到新 App 时 404/TypeError（P1.3 的 react 周期被 npm install 的
     3.5s 掩护过）。修：两处查不到时 registry.rescan() 一次再判定（与 requireApp 同款
     自愈）。实测 create→立即 run 462ms 一次成功。
  2. **Electron 跨 scale 显示器一次性 setBounds 的尺寸怪癖**：主屏(1.5)→副屏(1.0) 时
     宽高被缩成 targetScale/primaryScale（480×320 → 320×213 物理实测），x/y 不受影响。
     修：恢复拆「先 setBounds 移动、窗口落到目标屏后 setSize 定尺寸」。修后副屏恢复
     精确 (3980,200,480,320) 物理，同屏恢复不回归 (1404,1044,444,360)。
  3. **观测器教训**：scripts/list-windows.ps1 是 DPI-unaware 虚拟化坐标（各屏物理 ÷ 该屏
     scale），不是物理像素——与 a11y 物理值对不上差点误判回归。已记入 windows-pitfalls。
- 真机验收全过：真实拖拽保存（moved/resized+防抖，state 存 DIP 与物理 ×1.5 自洽）、
  同屏/跨屏恢复、过期坐标 (5000,5000) 回退默认 + 日志、最小化后停启尺寸正常、
  SDK 动态窗口路径零变化（检查确认）。
- 命名对齐：实现用 winBounds（roadmap 行文写 windowBounds），roadmap 记录已按实现名勘误。
