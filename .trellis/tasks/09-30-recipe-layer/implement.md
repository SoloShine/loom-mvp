# 执行计划 — recipe 声明式工具层

前置：design.md 已收口（2026-09-30，验收场景 1/2/4 必做、3 加时赛已确认）；实现载体为 `apps/recipe-runner/`（P1.3 react 模板管线）+ `apps/recipe-runner/tests/`（engine 单测，node:test 组织；构建方式与现有 app 测试先例对齐，无先例则 esbuild 打 dist-test 后运行）。Host / CLI / SDK **零改动**是全程红线（验收项）。

## 阶段 1：engine 纯函数核心（TDD，先行）

- [ ] `recipes.schema.json`（JSON Schema draft-07：id/name/hotkey/onRun/params/onerror/steps/for/out/args）
- [ ] `engine/parse.ts`：yaml → ajv 校验 + 语义检查（步骤 id 重复、嵌套超限、引用不存在的 id——警告不拒）
- [ ] 表达式求值：`{{ }}` 插值 + 整值单一表达式类型保真（`Function` 求值，上下文 params/steps/循环变量/env）
- [ ] `engine/interp.ts`：线性循环 + 动作注入表；when 条件、for each / for times、错误即停、协作取消、保护参数（迭代 1000 / 单步 30s / ui 120s / 总 10min，均可 override）
- [ ] `engine/trace.ts`：TraceStep 落迹、out 4KB 截断、runs 环形保留 10 次
- [ ] 参数取值链纯函数（override > preset > lastUsed > default）
- [ ] dry-run 语义表实现（skip 动作记「将做什么」）
- [ ] 单测：上述每一项 + fake actions 全路径（成功 / 错误即停 / skipped / cancelled / replayed）

验证：engine 单测全绿（`node --test` 或现有测试入口）。
回滚点：纯新增目录，git checkout 即净。

## 阶段 2：动作接线与编排（main.ts）

- [ ] host.* 直通动作（clipboard / files / screen / mouse / keyboard / notification / log / `process.run`）
- [ ] runner util：`fs.list`（只读）、text / json 变换、`http.request`、`delay`、`js.eval`
- [ ] `ui.*` 转发协议（main ↔ UI：`host.ui.send` / `host.ui.onMessage`；执行时窗口不可见则唤起）
- [ ] 热键编排：onStart 扫描注册（`host.hotkey.register`，冲突标记不阻塞）、recipes 目录 fs.watch（300ms 防抖）重扫 + 重注册、invoke 时兜底重读盘
- [ ] invoke 入口：`run { recipe, params?, preset?, fromStep? }` → 立即返回 `{ runId }`；`stop`；`check { recipe? }`
- [ ] manifest：ui: window（react 管线）+ commands（run/stop/check）；onStart 后 `host.window.hide` 收起
- [ ] storage 布局：`runs/<recipeId>`、`params/<recipeId>/lastUsed`、`params/<recipeId>/presets`

验证：`npm run build` → `mini validate recipe-runner` → `mini invoke recipe-runner check` 真机通过；临时手写 recipe 走一遍 run。
回滚点：runner 为 disabled 状态即可隔离，Host 侧无影响。

## 阶段 3：UI（react 模板，单向投影）

- [ ] schema→form 渲染器（string/number/boolean/select；params 与 ui.ask 共用；required 校验）
- [ ] 配方列表（含 invalid / hotkey-conflict 标记）+ 详情：步骤行 × 最近 run 轨迹叠加（状态点 / 耗时 / 展开 args 与截断 out）
- [ ] 动作按钮：运行 / dry-run / 从第 N 步重跑 / 停止；presets 另存为 / 套用；参数表单按取值链预填

验证：`mini run recipe-runner` 真机；`cd apps/recipe-runner && npm run dev` 后 devUrl 热更路径可用（P1.2 管线）。

## 阶段 4：验收场景（AI 全链路）

- [x] 场景 1 下载目录批量重命名：描述 → agent 依 schema.json 生成 → check → 热键 / launcher 执行 → 轨迹可读 → 改一行立即生效（含真 ui.confirm 表单应答、Esc 取消路径、从 confirm 步重跑）
- [x] 场景 2 剪贴板格式转换（零交互纯管道，纯热键即走；剪贴板先备份后恢复）
- [x] 场景 4 键鼠一次性宏：for times + keyboard.press / mouse.click / delay 节拍（沙箱 notepad 窗口内安全真跑）
- [x] 场景 3 选区截图存档（加时赛达成）：固定 rect captureRegion → js.eval 剥 base64 → certutil 解码落盘（selectRegion 交互留人工清单）
- [x] PRD 验收标准逐条勾选（含「Host 代码 diff 为零」——`git diff --stat host/ cli/ sdk/` 为空；验收发现 showForm 窗口泄漏已修，见 design.md 阶段 4 回写）

## 阶段 5：收尾（Trellis Phase 3）

- [ ] README：recipe 语法、agent 生成指引（schema.json 用法）、信任模型说明（recipe = 可信内容，js.eval 无沙箱）
- [ ] 全量 `npm test` + smoke + 真机清单
- [ ] spec 更新（recipe/app 分界原则 R6 → guides；runner 模式若有可复用契约 → mini-host/backend）
- [ ] journal + commit（runner 独立提交，回滚 = revert 单提交）

## 审查门

- 门 1（阶段 1 末）：engine 单测 + 设计偏差记录（若实现中发现 design 缺口，先回写 design.md 再继续）
- 门 2（阶段 2 末）：真机 invoke 链路可用，才进 UI
- 门 3（阶段 4 末）：PRD 验收逐条过，含零 Host diff 断言
