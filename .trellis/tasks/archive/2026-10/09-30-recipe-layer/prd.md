# recipe 声明式工具层（P3 首项）

## Goal

内置 runner App + 声明式 YAML recipe：线性解释执行、JSON Schema 校验、结构化运行轨迹、ui.* 交互步骤、动态热键触发，零 Host 改动。

让「组合已有动作」类小工具的生产成本从「一个 TS 工程」降到「一段可校验的 YAML」，且改完即生效（无 build、无 reload）。

## 背景

- MVP 已收官（`docs/post-mvp-plan.md` P0–P2 完成），P3 的主题是「工具从哪来」。现状只有一条生产路径：agent 生成 TS 工程 → esbuild → reload；对简单串步骤类需求过重，authoring 回路长，且代码改动有进程崩溃面。
- 参照系：Quicker（自有 DSL + 组件拼装覆盖 95% 需求、解释执行改完即生效）。loom 的差异化 = **去掉可视化画布，作者席交给 AI**（agent 按 schema 生成，人审阅微调）。
- 关键已核实事实：`host.hotkey.register` 运行时动态注册已实现（`host/src/main/services/dispatcher.ts` hotkey 分支，先到先得 + fire 事件回推）——PRD §7.6 预留的口子正是为此；host.* 十一类原语（clipboard / files / storage / screen / mouse / keyboard / process / notification / hotkey / window / log）已构成桌面 RPA 动作库的核心子集。

## Requirements

### R1 形态与边界

1. **一个内置 runner mini-app**（`apps/` 下的普通 App）+ recipe 目录；**Host 零改动**，不新增任何 Host API（不触发 PRD §21「三个 App 才准进 Host」门槛）。
2. recipe = YAML 数据文件，**文本是唯一事实源**；invoke 时读取（或 fs.watch），改完即生效。
3. 执行语义锁死**线性解释器**：顺序 + 条件（when）+ 循环 + 错误即停。无并行、无持久化可恢复 run、无事件触发。
4. 每步必有**稳定短 id**（输出引用 `from:`、错误定位、AI 指代都靠它）；**嵌套深度上限**：if/loop 体是唯一允许的嵌套，控制流不套控制流。
5. **逃生舱步骤**：内联 JS、spawn helper；二期候选：invoke 其它 App 的 command（invoke 语义已存在）。

### R2 动作词表（v0）

- 直接映射 host.* 原语：clipboard / files / screen / notification / process(helper) / log 等。
- runner 进程内轻量动作：text / JSON / regex 变换、HTTP（utilityProcess 内 Node fetch）、delay。
- **交互步骤**（阻塞式，返回值即该步 `out`）：`ui.ask` / `ui.confirm` / `ui.menu` + 既有 `files.selectFile/selectDirectory`、`screen.selectRegion`、`mouse.waitClick`。词表到此为止，**不做 YAML 内 UI 布局能力**。
- `params`（启动表单）与 `ui.ask`（中途表单）**共用同一个 schema→form 渲染器**。
- **参数模型**：
  - 取值链 per-run override > last-used（runner storage 按 recipe 记忆上次表单值）> 声明默认值；表单按此链预填。
  - 命名参数集（presets）：表单「另存为 / 套用」，存 runner storage（不进 recipe 文件）；`mini invoke` 可带 preset 启动。
  - 触发时参数入口：`onRun: silent | ask`（缺省 silent——按取值链静默启动；`ask` 则热键 / launcher 触发先弹表单；required 参数无值时无论何种模式都弹表单）。
  - param 与 ask 的分界原则：值跨 run 复用 → param（自动获得 last-used 记忆）；纯当次上下文 → `ui.ask`（不持久）。

### R3 触发

v0 = launcher 命令 + 动态热键（recipe 声明热键，runner 经 `host.hotkey.register` 注册）。定时、文件监视、窗口上下文全部后置。

### R4 校验（AI 时代的安全网）

recipe 定义 JSON Schema；`mini validate` 同口径校验——agent 生成错误在**校验期**拦截，不进运行时。

### R5 调试与阅读

1. 解释器产出**结构化轨迹**：每步解析后实参、输出、状态、耗时（交互步骤记录等待时长与返回值）。
2. UI = **单向投影**（参照管理中心对 manifest 的既有模式：文本编辑 + fs.watch 自动生效 + UI 只读展示与动作按钮）：步骤清单 × 最近 run 轨迹叠加（绿/红标记、展开看输入输出）、params 表单、运行 / dry-run / 从第 N 步重跑按钮。
3. dry-run：变更类动作（鼠标 / 键盘 / 写文件 / 剪贴板）跳过或仅回显，读取类与交互类照真执行。
4. 从第 N 步重跑：基于上次 run 已记录的各步输出。
5. 保留最近 N 次 run（runner storage）。
6. **不做可视化结构编辑**（拖拽、连线、换序）；未来最远到「单步参数 schema 表单写回 YAML」，且排 v1 之后。

### R6 recipe / App 分界原则（写进项目认知）

判断轴不是大小或寿命，是两个可判定的轴：

- **结构复杂度超限**（嵌套想超限、步骤膨胀、绑定链过长、需要新算法）→ 升格为代码 App；
- **交互密度超限**（人等流程：持久窗口、状态化表单、结果探索）→ App（React 模板即 P1.3 产物）；
- 流程等人（偶尔确认 / 补参数 / 选区域）→ recipe 的领地；长期稳定的小 recipe 不必升格。
- **首个真实分界案例（2026-09-30，用户提出）**：按键 → 坐标点击实时映射——事件驱动、运行无界（游戏进行期间常开）、需要全局按键监听（host 无此原语，须经 helper），配置形态是动态键值对表而非参数表单。判定：实时映射 = **app**；一次性退化形态（热键触发后执行固定的「按键 + 点击」序列）= recipe 可表达的有限流。用户确认双轨：**A 宏版进本任务**（验收场景 4）；**B 实时映射版独立 mini app**，排入 P3 候选（post-mvp-plan P3.2）。

## 非目标（延续 PRD §18 与 post-mvp-plan「明确不做」）

可视化画布 / 积木编辑器；并行分支与 join；durable execution（断点续跑仅指「从第 N 步重跑」）；定时 / 文件 / 窗口触发器；连接器生态与商店；YAML 内 UI 布局；跨 App 编排（二期再议）。

## Acceptance Criteria

- [ ] 一个真实需求走通全链路：自然语言描述 → AI 生成 recipe → `mini validate` 通过 → launcher / 热键执行成功 → 管理页轨迹可读 → 改一行 YAML 再次执行立即生效，全程无 build / reload。
- [ ] 含至少一个交互步骤（如 `ui.confirm`）与参数绑定的 recipe 可运行，取消路径按错误即停终止。
- [ ] dry-run 可用：变更动作被跳过且轨迹中可见 skipped 标记。
- [ ] 从第 N 步重跑可用（前序步骤使用上次记录输出）。
- [ ] recipe 改动后，热键 / launcher 侧无需任何重载动作即按新内容执行。
- [ ] Host 代码 diff 为零（runner 完全以普通 App 形态交付）。

## 开放问题（brainstorm / design 阶段钉死）

1. 绑定语法与表达式语言：`{{expr}}` vs `$ref`；表达式是 JS 子集还是白名单函数集。
2. recipe 存放与发现：runner App 目录内 `recipes/*.yaml`？launcher 列出方式（v0 经 runner 的 manifest 命令中转）。
3. ~~词表 v0 具体清单与优先级，以哪 2–3 个真实需求作验收场景~~ **已定（2026-09-30）**：①下载目录批量重命名 + ②剪贴板格式转换 + ④键鼠一次性宏（keyboard.press + mouse.click 序列）必做；③选区截图存档加时赛；键鼠联动实时映射版 = 独立 app 排 P3（见 R6 案例记录）。
4. params / ask 表单与轨迹视图的 UI 归属：管理中心新页 or runner 自建窗口。
5. dry-run 对每类动作的语义表（逐动作列 skip / echo / real）。
6. 循环的收敛保护（最大迭代数 / 超时）与错误即停的用户可见性（notification？）。

## 来源

2026-09-30 会话讨论（Quicker 参照、recipe vs workflow 引擎的语义阶梯、表现形式、交互词表、分界原则），共识由用户确认立项。
