# 执行计划 — 通知 onClick 交互化

前置：无。

## 步骤 1：纯校验模块 + core.ts + dispatcher（host 侧）

- [ ] `host/src/main/services/notificationClick.ts`（新,electron-free）：
      `validateClickCommand(clickCommand: unknown, declared: string[]): string | null`
- [ ] `host/src/main/services/core.ts`：notificationApi.show 新签名
      （appId/title/body/clickCommand/declaredCommands）+ click 接线 +
      `setNotificationClickDispatcher`（模块级回调槽,可选链调用）
- [ ] `host/src/main/services/dispatcher.ts`：notification case 取 registry 清单命令、
      透传 clickCommand（string ≤80 才透传）
- [ ] `host/src/main/runtime/manager.ts`：启动时注入分发回调
      （invoke 失败 warn 不阻断 + windows.focusApp）
- 验证：`npm run build`

## 步骤 2：SDK + file-organizer 接线（验收载体，用户定调不用连连看）

- [ ] `sdk/src/index.ts`：show 加 `clickCommand?: string` + JSDoc（语义与无副作用口径）
- [ ] `apps/file-organizer/app.yaml`：加 `show` 命令（title Show panel）
- [ ] `apps/file-organizer/src/main.ts`：invoke case `show` → `host.window.focusSelf()`；
      「移动去向」通知（~89 行,moved>0 块内）加 `clickCommand: "show"`
- 验证：`npm run build`；`mini build file-organizer`

## 步骤 3：契约测试

- [ ] host-contract：`validateClickCommand` 三分支（合法 null / 未声明含 id 的错误文案 /
      非字符串不在此层拒绝——口径见 design）
- 验证：`npm test` 全绿（44 + 新增）

## 步骤 4：真机验收（确定性流程,见 design 验收路径）✅ 2026-09-29 完成

- [x] 预置：data/acctest/sample/ 造文件；host 停机预置 file-organizer storage lastDir
- [x] run → preview → execute → 「已移动 N 个文件」通知 → 点击 →
      history show-invoke 事件 + 面板唤起 + host.log 干净
- [x] 对照：clipboard-tool clean 通知（无 clickCommand）→ 点击无副作用
- [x] 传未声明命令 → SDK 中文拒绝
- [x] 清理 acctest 与 storage 预置;roadmap P2.2 实施记录;spec 同步
- 风险文件：`host/src/main/services/core.ts`（不传 clickCommand 的调用点零差异）、
  `host/src/main/runtime/manager.ts`(注入点,不改 invoke 本体)。

## 回滚点

- 步骤 1-3 逐文件 git checkout;连连看两文件独立回退。
- SDK 签名只增不改,旧产物无兼容面。

## task.py start 前检查

- [x] implement.jsonl / check.jsonl 已填真实条目
- [x] prd.md 收敛通过（无 Open Question、无重复段落）
- [x] 用户已明确批准本规划摘要

## 实施记录（2026-09-29 完成）

- 实现（trellis-implement）+ 检查（trellis-check PASS-with-nits,0 缺陷）：45/45 测试、smoke 5/5、
  build 绿。校验顺序偏离：clickCommand 校验先于 isSupported()（fail-fast,所有平台一致拒绝）。
- **真机验收（确定性流程 + 用户人肉点击）**：
  - 自动化部分：storage 预置 lastDir（host 停机）→ run → preview(3) → execute(moved 3) →
    通知必现 ✓；`mini invoke file-organizer show` → focusSelf ✓（确定性）。
  - **通知物理点击无法合成**：系统专注模式把 toast 压成 0 高度窗口（a11y 树为空）；
    通知中心行 AXPress = 展开非激活；原始按键被前台限制拒绝。三条路径失败后由用户
    人肉点击完成：点击 File Organizer 通知 → `invoke show success`（history 15:20:00 实录）
    + 面板弹出 ✓；对照 clipboard-tool 通知点击 → 无任何反应 ✓（R6 验收双侧通过）。
- 经验沉淀：toast 激活是唯一无法自动化的验收环节；勿扰/专注模式会让横幅高度为 0
  （toast 窗口存在但无 a11y 内容）。
