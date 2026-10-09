# 技术设计 — recipe 声明式工具层

## 总体结构（核心决策：runner 是普通 App，Host / CLI 零改动）

```text
apps/recipe-runner/
├── app.yaml            # ui: window（React，P1.3 react 模板管线）；commands: recipes / run / stop / check
│                       # 不声明 lifecycle.idleStopMinutes（缺省 = 不闲置回收：热键常驻的前提）
├── package.json        # react 模板同款（vite 仅 dev server）+ ajv
├── recipes.schema.json # recipe JSON Schema —— 唯一事实源：运行时校验与 agent 生成共用
├── recipes/            # 用户 / agent 编辑区（进版本库）；registry 顶层 watch 是 non-recursive，不受扰动
│   └── rename-downloads.yaml
├── src/
│   ├── main.ts         # 生命周期 + 热键编排 + invoke 入口 + recipes 目录 watch
│   ├── engine/         # 纯函数核心（可单测）：parse / interp / trace / actions
│   │   ├── parse.ts    # yaml → Recipe（经 ajv 校验 + 语义检查：id 重复 / 嵌套深度 / 引用不存在）
│   │   ├── interp.ts   # 线性解释循环；动作经注入表 dispatch（测试用 fake actions）
│   │   └── trace.ts    # TraceStep 结构、截断、runs 环形保留
│   └── ui.tsx          # 配方列表 × 轨迹叠加 + params/ask 表单（同一 schema→form 渲染器）
└── README.md
```

- **热键常驻**：onStart 扫描 recipes → 逐个 `host.hotkey.register(combo, cb)`（SDK 直连回调，先到先得；冲突不抢占，recipe 标记 `hotkey-conflict`，UI 列表可见）。
- **改完即生效**：runner 对 `recipes/` 自建 fs.watch（300ms 防抖）→ 重扫 + 校验 + 重注册热键；invoke 时再读盘一次兜底。校验失败的 recipe 标记 `invalid`（错误进 UI 与 app log），不阻塞其它 recipe。
- **invoke 语义**：`invoke("run", { recipe, params?, fromStep? })` 立即返回 `{ runId }`（fire-and-forget——manager 的 invoke 120s 等待上限不约束 run 时长，时长由 runner 自带总超时管）；`invoke("stop")` / UI 停止按钮 → 协作式取消（步间检查点 + 交互等待可中断）。
- **UI 窗口**：manifest 窗口随 start 创建；onStart 后 `host.window.hide` 收起（launcher 唤起语义不变）。`ui.*` 步骤执行时若无可见窗口则临时唤起。

## 表达式与绑定（取舍表）

| 取舍 | 选择 | 理由 |
|------|------|------|
| 表达式语言 | 直接用 JS（`Function` 构造器求值），不发明 DSL | 信任模型与 App 代码等同（PRD §16 只运行可信代码，recipe 是可信内容）；自造语言是最大深渊；agent 的 JS 语料无限 |
| 绑定语法 | 字符串内 `{{ expr }}` 插值；**整个值恰为单一 `{{ }}`** 时返回原始类型（不字符串化） | GitHub Actions 先例；YAML 值保持标量友好，类型化引用不需要额外字段 |
| 数据流 | 只有 `steps.<id>.out`（+ `params` / 循环变量 / `env.now`）可引用；**不设 `from:` 字段**，输入统一写在 `args` 模板里 | 少一个概念；PRD 示例中的 `from:` 在此修正 |
| 求值失败 | 抛错 = 该步失败，走错误即停 | 绑定错误在第一步执行前可静态检出「引用了不存在的 id」（parse 期警告，不强拒） |

## recipe schema（v0 词表，示意）

```yaml
id: rename-downloads
name: 下载目录批量重命名
hotkey: Ctrl+Alt+R            # 可选，动态注册
onRun: silent                 # silent（缺省）| ask：热键/launcher 触发是否先弹参数表单
params:
  dir: { label: 目录, type: string, default: "D:\\Downloads", required: true }
onerror: notify               # notify | silent，缺省 notify
steps:
  - id: list
    action: fs.list           # runner util（只读）
    args: { dir: "{{params.dir}}", filter: "*.pdf" }
    out: files
  - id: confirm
    action: ui.confirm
    args: { title: "将重命名 {{steps.list.files.length}} 个文件" }
  - id: ren
    for: { each: f, in: "{{steps.list.files}}" }   # 唯一允许的嵌套层
    steps:
      - id: one
        action: files.move
        args: { from: "{{f.path}}", to: "{{dir}}\\{{f.stem}}.pdf" }
  - id: done
    action: notification.show
    args: { title: 完成, body: "{{steps.list.files.length}} 项" }
```

**动作分两源，判据一句话：凡改变世界或读屏幕的走 host.\*，纯计算的走 runner util。**

- host.* 直通：clipboard / files(read·write·copy·move·remove·selectFile·selectDirectory) / screen / mouse / keyboard / notification / `process.run`（spawn + wait + stdout 收集，阻塞至退出码；后台 spawn + 后续等待 = v1 候选）/ log。
- runner util：`fs.list`（只读，Node fs）、`text.match` / `text.replace` / `text.template`、`json.parse` / `json.path`、`http.request`（Node fetch）、`delay`。
- 交互步骤：`ui.ask` / `ui.confirm` / `ui.menu`——main.ts 转发到本 App 窗口（`host.ui.send` ↔ `host.ui.onMessage`），返回值即该步 `out`；用户取消 = 错误即停。
- 逃生舱：`js.eval`（内联 JS，上下文同绑定）、`process.spawn`（helper）。

## 参数模型（last-used / presets / 触发时表单）

| 机制 | 设计 | 理由 |
|------|------|------|
| 取值链 | per-run override > last-used（storage 按 recipe 记忆上次表单值）> 声明默认值；表单预填同链 | 「用上次那组值」是高频诉求；file-organizer 的 lastDir（P2.2 验收载体的 storage 预置）已验证该心智 |
| presets | 命名参数集：表单「另存为 / 套用」，存 runner storage，**不进 recipe 文件**；`invoke run { recipe, preset }` 可指定 | 同一 recipe 的多组常用条件（如工作 / 个人目录）不需要复制 recipe；preset 是用户运行时数据，不属于 agent 编辑的版本化内容，混进 recipe 文件会造成双写冲突 |
| 触发时入口 | `onRun: silent`（缺省）按取值链静默启动；`onRun: ask` 热 / launcher 触发先弹表单；**required 参数无值时无论何种模式都弹** | 全默认值的 recipe 热键即走（快路径，Quicker 体感）；必填无默认的不会静默失败 |
| ask 不持久 | `ui.*` 答案只进当次轨迹，不记忆；反复输同一个值 = 该值应升格为 param 的信号（自动获得 last-used） | param / ask 分界 = 值是否跨 run 复用；两条记忆通道合一，避免 ask 也长出记忆语义 |

实现落点：last-used 与 presets 同存 `host.storage`（`params/<recipeId>/lastUsed`、`params/<recipeId>/presets`）；取值解析是 engine 内纯函数（可单测：override / preset / lastUsed / default 四层的覆盖顺序）。

## 执行语义 FAQ（循环 / 并行 / 阻塞等待）

| 能力 | v0 结论 | 出口 / 替代 |
|------|---------|------------|
| 循环 | 仅 `for: { each }`（遍历集合）与 `for: { times: N }`（固定次数）；**无 while、无 break** | 无界循环 / 中途跳出 = 升格为 app 的信号；迭代上限 1000（可 override）+ 控制流不套控制流 |
| 并行 | **步骤之间永远无并行**（设计承诺，非 v0 缺失） | 并行只允许存在于**单个动作内部**：js.eval 里 Promise.all、未来 http.batch——「并发取 10 个 URL」是一个步骤内部的事，不是十个步骤并行。桌面动作（鼠标 / 键盘 / 剪贴板）是全局共享状态，步骤级并行 = 不确定的点击时序，永远不开 |
| 等用户 | `ui.*`：阻塞至响应 / 取消，步超时 120s | — |
| 等时间 | `delay`：计入 run 总超时（10 分钟，可 override） | — |
| 等进程 | `process.run`：阻塞至退出码，stdout / exitCode 即 out | — |
| 等条件 | `wait.until { expr, intervalMs, timeoutMs }` **不进 v0，列为 v1 首选候选** | v0 workaround：for.times + delay + when（丑但有限）；「等 X 出现再点」是 RPA 完全体最后一块，两个必做验收场景都不需要，故后置 |
| 等事件（按键 / 文件 / 窗口） | 不做——这是触发器层（PRD 非目标） | 独立 app（与键鼠联动判例同源） |

## dry-run 语义表（逐动作）

| 语义 | 动作 |
|------|------|
| skip（记录「将做什么」） | files.write/copy/move/remove、clipboard.writeText、mouse.\*、keyboard.\* |
| real（照真执行） | 全部读类（fs.list、files.read、clipboard.readText、screen、http）、`ui.*`、delay、js.eval |
| real + 标记 | notification.show（文案加 `[dry-run]` 前缀） |

## 执行器与轨迹

- `interp.ts`：async 线性循环，动作表可注入（单测 fake）。每步产出 `TraceStep { id, action, args(解析后), status: ok\|skipped\|error\|replayed\|cancelled, out?, error?, ms, waitedMs? }`。
- 轨迹存储：`host.storage.set("runs/<recipeId>", …)` 环形保留最近 10 次；`out` 超 4KB 截断（记长度 + 摘要，截图 base64 不落轨迹全量）。
- **从第 N 步重跑**：以上次 run 各步 `out` 作为初始上下文，前序步骤标记 `replayed`；循环体内步骤以循环变量为界重放。
- 保护参数：`for` 最大迭代 1000（recipe 可 override）；单步超时 30s（`ui.*` 120s）；run 总超时 10 分钟（可 override）。超限 = 错误即停 + notification。
- 错误即停：失败步记 error，后续标 skipped；`onerror: notify` 时发失败摘要（含失败步 id 与错误消息）。

## UI（取舍表）

| 取舍 | 选择 | 理由 |
|------|------|------|
| UI 归属 | **runner 自建 React 窗口** | 管理中心页 = Host 改动，违反「零 Host diff」验收项；runner 窗口复用 P1.3 模板管线零成本；将来若要管理中心集成，另立任务 |
| params 表单与 `ui.ask` | **同一个 schema→form 渲染器**（类型：string / number / boolean / select；ask 的选项即 select） | 一次工程两处复用（PRD R2 原文） |
| 轨迹视图 | 步骤行 = 状态点 + id + action + 耗时，展开看解析后 args 与 out（截断显示） | 线性轨迹与 recipe 1:1，无需 run 可视化 |
| 编辑 | 只读投影 + 动作按钮（运行 / dry-run / 从第 N 步重跑 / 停止 / 复制 YAML 路径） | 单向投影边界（PRD R5） |

## 验收场景（已确认 2026-09-30）

1. **下载目录批量重命名**（必做，核心）：fs.list → text 变换 → ui.confirm 清单 → 循环 files.move → notification。覆盖：列表、绑定、交互、循环、dry-run、从第 N 步重跑、热键触发。
2. **剪贴板格式转换**（必做，轻）：clipboard.readText → text.replace → clipboard.writeText → notification。覆盖：零交互纯管道、纯热键即走路径。
3. **选区截图存档**（加时赛）：screen.selectRegion → captureRegion → runner util 解码 dataURL → files.write。顺带实证 PRD §2.4 的「截图经 App 自有 helper 落盘」模式。
4. **键鼠一次性宏（必做，A 版，2026-09-30 用户确认）**：热键触发 → `for times` 循环内 `keyboard.press` + `mouse.click` 交替序列（如游戏固定连招 / 开场操作）。覆盖：输入注入动作、固定次数循环、毫秒级 `delay` 节拍。
5. **键鼠实时映射（B 版，R6 判例，不入本任务）**：按键 → 坐标点击实时映射。判定为 app 形态，理由：事件驱动（按键是触发器而非流程步骤）、运行无界（进行期间常开，与循环上限 / 总超时保护冲突）、需要全局按键监听原语（host 无 `keyboard.listen`，须 App 自有 helper 实现 WH_KEYBOARD_LL）、配置形态是动态键值对表（params 表单 schema 不覆盖）。技术上一个 `key.map` 阻塞步骤 + runner 自带 helper 机械上可行，但**故意不这么做**——那会让 recipe 长期挂着无界监听 run，破坏「有限流」的执行语义。独立 App 的零 Host 改动路径已通：`mouse.waitClick` 取坐标、动态热键开关、`process.spawn` 起 helper（helper 选型自由，AHK 是现成候选）。

> 键鼠联动判例同时暴露了平台的一块长期缺口：**常驻事件层**（键盘 / 剪贴板 / 文件 / 窗口事件订阅）。Quicker 的「持续运行和监控」容易，是因为它的地基就是常驻输入钩子层——监控类功能只是事件流上跑规则。loom 的演化路径：recipe 层（动作层：做什么）先建；当第 2~3 个监控型需求出现，事件源按 PRD 三问门槛提升为 host 服务（`keyboard.listen` / `clipboard.onChange` / `fs.watch` / `window.onFocus`），响应动作复用 recipe 词表。Quicker = 事件层 + 动作层一体成型；loom 分两层各自保持简单，组合出同等能力。B（key-click-mapper）是该演化的第一个采样点，以其自有 helper 先行验证输入钩子的工程坑（全键吞吐延迟、冲突、误吞输入），为将来可能的 host 化积累数据。

## 校验与工具链

- `recipes.schema.json`（JSON Schema draft-07）为唯一事实源；runner 用 ajv 校验，agent 直接拿 schema 文件生成。
- 校验入口：`mini invoke recipe-runner check --args recipe=<id>`（或无参查全部）——CLI 本身零改动。
- parse 期语义检查（ajv 之外）：步骤 id 重复、嵌套超限（控制流不套控制流）、引用不存在的步骤 id（警告）。

## 测试

- engine 纯函数单测（node:test，tests/ 或 app 内 tests/，随现有测试布局）：parse 语义检查 / interp + fake actions（成功、错误即停、跳过、取消、循环上限、重放）/ dry-run 语义表逐动作 / 轨迹截断与环形保留 / 表达式求值（单一表达式类型保真、插值、引用缺失）。
- 真机：按 PRD 验收标准走两个必做场景全链路（AI 生成 → check → 热键/launcher 执行 → 轨迹可读 → 改一行立即生效）。

## 兼容与回滚

- Host / CLI 零 diff；回滚 = 禁用或删除 `apps/recipe-runner/`（recipes 在 App 目录内，删即净）。
- 热键先到先得，不抢占既有 App；`Ctrl+Shift+M` 等 Host 热键天然免疫。

## 风险

- **`Function` 求值 = 任意代码执行**：信任模型与 App 代码一致（PRD §16），README 明示 recipe 是可信内容，不做沙箱。
- **storage 轨迹膨胀**：截断 + 只存最近 10 次；超限内容（截图）只记摘要。
- **`ui.*` 在窗口不可用时**：执行时强制唤起/建窗；若 Host 未来提供 headless 上下文再议回退（v0 不做静默默认值）。
- **ajv 新依赖**：仅进 runner App 的 package.json，不触 Host / CLI / SDK。

## 实现偏差与落地补充（阶段 1 回写，2026-09-30）

engine 纯函数核心落地时补齐的细节，均以本节为准：

1. **保护参数覆盖入口 = 顶层 `limits` 块**：design 只说「可 override」未定字段名。落地为
   `limits: { maxIterations, stepTimeoutMs, uiStepTimeoutMs, runTimeoutMs }`（schema 定义 + interp `DEFAULT_LIMITS` 缺省 1000 / 30s / 120s / 10min）。
2. **for 步骤是纯容器**：step = `action` 叶子 ∣ `for`+`steps` 容器二选一（schema anyOf 锁死），容器不自带 action。容器在轨迹中落一条 `action: "for"` 的条目（先落迹，子步骤条目带 `iter` 迭代序号排其后，UI 可缩进渲染）。
3. **when 语法锁定**：必须是单一 `{{ 表达式 }}`（或布尔字面量），求值结果按 JS 真值判定。不做「插值后字符串真值」的模糊语义——agent 生成错误在 schema 期即拦。
4. **TraceStep 增补字段**：`iter`（循环子步骤迭代序号）、`skipReason`（`when` ∣ `dry-run`）、`note`（dry-run 跳过时记录「将执行 \<action\> + 解析后 args」）。replayed 步骤的 args 记声明原文（未重新求值）。**循环中断时未开始的迭代不落迹**（否则 1000 次上限会产生海量占位条目）。
5. **out 落点统一表述**：输出存 `steps.<id>.<out名>`，out 缺省键名即 `"out"`——design 示例的 `steps.list.files`（out: files）与缺省的 `steps.<id>.out` 是同一机制。
6. **run 总超时作用于在途动作**：动作超时上限 = min(动作类别超时, 剩余 run 预算)；剩余预算更小时报「run 总超时」而非「步骤超时」，两者文案可区分。
7. **取消归因**：动作观察 AbortSignal 后主动抛错 → 该步记 `cancelled` 而非 `error`（用户主动停止不是失败）。
8. **引用扫描静态层**：parse 期对含 `{{` 的字符串（args 深度 + when + for.in/times）扫 `steps.x` 与 `steps["x"]` 两种写法，未知 id 仅警告。
9. **引擎模块拆分**：`src/engine/` = `types / expr / params / parse / interp / trace / index`（index 为打包出口）；测试在 `apps/recipe-runner/tests/*.test.cjs`（node:test + esbuild 现场编译 helper，先例同根 tests/），运行：`cd apps/recipe-runner && npm test`（等价 `node --test "apps/recipe-runner/tests/*.test.cjs"`，注意 node --test 目录参数在 Windows 下不生效须用 glob）。

## 实现偏差与落地补充（阶段 2 回写，2026-09-30）

动作接线与 main.ts 编排落地时补齐的细节，均以本节为准：

1. **步骤超时也触发动作级 AbortSignal**：`ActionRunContext.signal` 从「run 级取消信号」改为「步骤级组合信号」——用户 stop（run 级）或该步超时都会触发。动机：`process.run` 超时若不杀子进程会泄漏到 run 结束之后；表单/`delay` 同理需要清理钩子。归因不变：只有 run 级取消记 `cancelled`，超时仍记 `error`（文案「步骤超时」）。时序上先 reject 再 abort，动作的 AbortError 不会抢跑超时文案。
2. **js.eval 的上下文透传**：`ActionRunContext` 增补可选 `scope`（engine 的求值上下文 params/steps/env/循环变量），interp 逐步传入；`js.eval` 动作据此求值。实现为 async 包装（`return (async () => (code))()`），表达式位的 `await` 与 `Promise.all` 均可用——「并发 N 个请求」是单个动作内部的事。
3. **dry-run 分类的两处细化**（语义表未覆盖的动作）：`files.selectFile/selectDirectory`、`screen.selectRegion` 归 **interactive**（模态等用户，走 120s 档；dry-run 语义同为 real）——语义表把 screen 整体归读类，此处按「等用户」拆出超时档；`process.run` 归 **mutating**（改变世界，dry-run 下 skip 并记「将做什么」）。
4. **文件/选区对话框的取消不是错误**：`files.select*` 与 `screen.selectRegion` 用户取消返回 `null`（recipe 用 `when` 判空走「没选」分支），与 `ui.*` 的「用户取消 = 错误即停」刻意区分：对话框选空是合法输入，confirm/menu 的取消是放弃流程。
5. **`process.run` 非零退出码不报错**：out = `{ exitCode, stdout, stderr }`（stdout/stderr 按行收集后换行拼接）；recipe 用 `when: "{{steps.x.exitCode}} !== 0"` 自行分支。命令不存在/无法 spawn 才走错误即停。`timeoutMs` 不设独立上限（同 delay，交 run 剩余预算），取消/超时会 kill 子进程。
6. **fs.list 的 out 形状**：顶层文件（不含子目录）数组，每项 `{ path, name, stem, ext, size, mtimeMs }`；`path` 为正斜杠形式（windows-pitfalls：落 JSON/state 的路径纪律）。`filter` 是简化 glob（`*` / `?`，大小写不敏感），非法 pattern 走错误即停。
7. **常驻窗口的收起时机**：manifest 窗口在 `mini-started` 之后才由 Host 创建——onStart 里 `host.window.hide()` 会扑空。落地为：UI 首次上报 `ready` 消息时收起。表单（params / ui.*）经 `showForm` 网关「先 `focusSelf` 唤起再下发表单」，结束后收回（用户手动打开的窗口会被一并收起——v0 已知取舍，阶段 3 重估）。表单协议：main→UI `{type:"form", formId, kind: ask|confirm|menu, ...}` / `{type:"form-dismiss"}`，UI→main `{type:"form-result", formId, value}` / `{type:"form-cancel"}` / `{type:"ready"}`；网关自带 125s 兜底清理（略大于 uiStepTimeoutMs，让步骤超时先赢错误归因）。
8. **并发受理与全局串行链**：`invoke run` 校验（存在 / 有效 / 非 BUSY）后立即返回 `{ runId }`；参数解析、ask 表单、执行、落迹全部在队列任务内。所有 run（含纯计算型）排同一条全局 Promise 串行链——desktop 动作全局互斥的保守实现，v0 不做动作级互斥粒度。同一 recipe 在途时第二个 run 报 `BUSY`；`stop` 无参取消全部在途 run（含已入队未启动的——入队即登记 AbortController）。
9. **runId 定宽可排序**：`<recipeId>-<8 位定宽 36 进制时间戳>-<4 位随机>`——时间戳补零使字典序 = 时间序（日志/列表直排）。`nextRunId` 在 `src/registry.ts`（编排纯函数层：扫描解析、热键先到先得计划、重扫增量 diff、params 表单字段构建、上次 run 的 out 提取，全部可单测）。
10. **dry-run 的 [dry-run] 前缀只改实际通知文案**：轨迹里记的是声明解析后的 args（无前缀）——前缀是执行期标记，不回写轨迹（轨迹忠实于 recipe 声明）。
11. **阶段 2 的 UI 是最小表单窗口**：`src/ui.ts` 为 vanilla DOM 形态（form/confirm/menu 三种 + required 校验 + Esc 取消），只为打通 showForm 协议真机链路；阶段 3 换 React 管线时协议字段不变。

## 实现偏差与落地补充（阶段 3 回写，2026-09-30）

React 主界面落地时补齐/修订的细节，均以本节为准（第 1 条修订阶段 2 回写第 7 条的收窗取舍）：

1. **窗口取舍重估（修订阶段 2 第 7 条）**：窗口只由用户显式动作关闭——main 不做任何程序化收起（「表单结束收窗连用户手动打开的窗口一起收」的问题随之消失），启动即展示主界面（manifest 窗口 ready-to-show 上屏）。`ui.*` 步骤执行时窗口被隐藏则 `focusSelf` 拉回、被用户销毁则 `host.window.create` 重建（风险节「强制唤起/建窗」的落地）；重建的窗口同样只由用户关闭。launcher/托盘语义不受影响。
2. **UI 查询/动作协议（经 host.ui / host.app 消息对）**：UI→main `{type:"req", reqId, action, args}`，main→UI `{type:"res", reqId, ok, data|error}`；main→UI `{type:"state"}` 主动推送刷新（recipes 重扫、run 受理/结束、preset 写入、直播轨迹 200ms 节流）。action 集：`list` / `detail {recipe, runIndex?}` / `getParamDefaults` / `applyPreset {preset}`（后两者为只读预填查询，套用 preset = 返回取值链叠加 preset 层的值）/ `run` / `dryRun` / `rerun {fromStep}` / `stop` / `savePreset {name, values}` / `deletePreset {name}` / `copyPath`（经 main 写剪贴板，渲染层无 clipboard API 权限问题）。
3. **skipAskForm**：UI 按钮触发的 run/dryRun/rerun 携带当前表单值并跳过 ask 弹窗（窗口里已收集过表单，required 在 UI 侧先拦）；`onRun: ask` 的弹窗语义保留给热键/launcher 触发路径。
4. **RunOptions.onStep 直播轨迹（engine 增补）**：落迹统一入口 `land()` = push + 通知，传 trace 数组引用（容器步骤的 ms/status 在结束时回填后补发一次通知）；main 侧 `liveRuns` 持引用、detail 读取时浅克隆各步。轨迹落 storage 仍在 run 结束时（环形 10 次）——直播靠内存态，重载进程即失（可接受：直播只服务「正在看」的场景）。
5. **detail 的轨迹选择**：在途 run 直播优先（`traceSource: "live"`）；否则历史（`runIndex` 时间序、缺省末位 = 最新）。UI 历史下拉即 runs 列表倒序展示（时间 + 成败 + dry-run 标记）。
6. **schema 无 description 字段**：详情头部的「描述」位显示派生元信息（id / hotkey / onRun / onerror / 步骤数 · 参数数），不为展示层新增 schema 字段（recipe 词表保持 v0 锁定）。
7. **dev 端口 5176**：devUrl 与 vite dev 脚本一致，避开 react 模板缺省 5174（可与其它 react App 的 dev server 并存）。ui.tsx 入口含 `createRoot` 副作用导出，vite Fast Refresh 不适用 → 编辑后整页 reload（与 P1.3 模板同形态），reload 后 App 重挂载、req 协议自动重建（真机验证过）。
8. **ui-logic.ts 纯函数层**：字段值处理（seed/finalize：number 编辑期存原始串、提交前定型）/ required 校验 / preset 合并删除 / 轨迹行分组（for 容器 + iter 子步骤）/ 声明骨架 pending 叠加 / `__truncated` 与耗时时间格式化——全部单测覆盖（`tests/ui-logic.test.cjs`，esbuild 现场编译 helper）；React 组件本身不测（无先例不引测试框架）。`__truncated` 形状判定在 ui-logic 重写而非 import engine/trace（后者引用 Buffer，不能进浏览器 bundle）。

## 实现偏差与落地补充（阶段 4 回写，2026-09-30）

验收全链路（AI 生成 → check → 真机执行 → 轨迹核验 → 改一行再跑立即生效）跑通 4 个场景时发现并落定的细节：

1. **showForm 窗口泄漏修复（main.ts）**：host dispatcher 的 `window.focusSelf` 恒返回 `null`（不透传 `focusApp` 的布尔结果，host 侧问题但零 Host diff 红线不可修），阶段 2/3 落地的 `if (!focused) create(...)` 因此每次交互步骤都误建一个 460x560 表单窗（本次验收实锤：两次 ui.confirm 各漏一窗）。修复在 runner 侧：新增 UI 存活探针——`focusSelf` 后推一次 `{type:"state"}`，1000ms 内收到任意 UI→main 消息（ready/req，活窗口必然轮询）即视为窗口存在直接下发表单；超时才走 `host.window.create` 重建，重建后再等 ready（≤8s）才发表单（防消息早于 React 挂载丢失）。探针挂起项由 onMessage 入口统一点亮。
2. **验收自动化与 OS 级输入应答的边界**：`ui.confirm` 表单可由外部自动化应答——DPI-aware 截图定位主窗口内未遮蔽的 primary 蓝色按钮（`#1f6feb`；遮罩下同名色被压暗不会误中）后 SendInput 点击；Esc 取消走 UI 既有的 keydown 处理。全程未依赖 Host 任何调试口。该路径仅用于无人值守验收，用户侧语义不变。
3. **last-used 会跨 run 记忆 skipConfirm 类开关**：dry-run 传入的 `params.skipConfirm=true` 会进 last-used，使下一次不带参数的真跑也静默跳过确认（验收时实锤，属取值链的正确行为而非 bug）。推论：**用于自动化绕行的布尔开关进 last-used 后需要显式传 false 才能恢复交互**；recipe 作者应把此类开关默认 false 并在注释里说明，或用 preset 管理。
4. **screen.captureRegion 的 args 形状是嵌套 `rect` 对象**（`{rect:{x,y,width,height}}`，模板值经 resolveArgs 深度解析保持数字类型）——schema 对 action args 不设形状约束，此类词表细节目前只能读 `src/actions/host.ts`；README 的 agent 生成指引需给动作参数表（阶段 5 待办）。
5. **纯 recipe 二进制落盘链**：`files.write` 只写 utf8 文本，截图等二进制落盘 = js.eval 剥 base64 → files.write 写 .b64 → `process.run certutil.exe -decode` → files.remove 清中间文件（场景 3 交付形态）。js.eval 里可访问全局 `Buffer`，但 `require` 不在 Function 全局作用域，故不能直接 fs 写盘。
6. **引用规范的教学点**：输出引用第一段必须是**步骤 id**（`steps.<id>.<out名>`）；把 out 名当第一段写（如 `steps.bundle.x`，bundle 是 out 名）静态扫描会误报「引用不存在的步骤 id」且运行时必炸——该警告实为有效信号，parse 层无需改。
7. **fire-and-forget run 的验证时序**：`invoke run` 立即返回 runId，轨迹落 storage 在 run 结束时；外部脚本验证需等待（或轮询 storage/日志）。验收脚本两次因 sleep 不足读到上一次 run 的记录/中间态文件（.b64 未清、notify 文案旧），均为读取侧竞态而非 runner 缺陷。
