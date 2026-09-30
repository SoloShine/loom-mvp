# 配方执行器 recipe-runner（Mini App）

recipe = **声明式有限流**：把「组合已有动作」类小工具的生产成本从「一个 TS 工程」降到
「一段可校验的 YAML」，改完即生效（无 build、无 reload）。执行语义锁死线性解释器：
顺序 + 条件 + 循环 + 错误即停；每步必有稳定短 id；有限流由保护参数兜底
（迭代上限 1000 / 单步 30s / ui 类 120s / run 总超时 10min，均可覆盖）。

**recipe / App 分界一句话**：组合已有动作的有限流程 → recipe；结构复杂度
（嵌套想超限、步骤膨胀、绑定链过长、需要新算法）或交互密度（持久窗口、状态化表单、
结果探索）超限 → 升格为代码 App；流程等人（偶尔确认 / 补参数 / 选区域）是 recipe 的领地。
判定轴与首个判例（键鼠实时映射 = app、一次性宏 = recipe）见任务 PRD R6
（`.trellis/tasks/09-30-recipe-layer/prd.md`）。

> 人类读者从「快速上手」进；coding agent 生成 recipe 时直接跳
> 「动作词表」与「agent 生成指引」，并以 `recipes.schema.json` 为唯一事实源。

## 快速上手

```bash
# 1. 放配方：apps/recipe-runner/recipes/<id>.yaml（顶层 id 与文件名一致）
# 2. 构建 + 校验（结构错误在校验期拦截，不进运行时）
npm run mini -- build recipe-runner
npm run mini -- validate recipe-runner          # manifest 校验
mini invoke recipe-runner check                 # 全部配方；--args '{"recipe":"<id>"}' 查单个
# 3. 运行（三入口）
mini run recipe-runner                          # 管理窗口：列表 → 详情 → 运行/dry-run/重跑/停止
mini invoke recipe-runner run --args '{"recipe":"clipboard-notify"}'   # CLI（fire-and-forget，立即返回 runId）
# 热键：recipe 声明 hotkey（如 Ctrl+Alt+L）即动态注册，先到先得不抢占
mini invoke recipe-runner stop                  # 停止在途 run（不带 recipe = 取消全部）
```

仓库自带 5 个成品配方（`recipes/`，全过 check）：`clipboard-notify`（零参数冒烟纯管道）、
`clipboard-markdown-links`（剪贴板格式转换，纯热键即走）、`rename-downloads`（批量重命名，
含 ui.confirm + for each + 参数取值链）、`macro-combo`（键鼠一次性宏，for times + delay 节拍）、
`screen-archive`（固定区域截图存档，js.eval + process.run 二进制落盘链）——生成前先读它们。

改 `recipes/*.yaml` 保存即生效：runner 自建 fs.watch（300ms 防抖）重扫 + 重注册热键，
invoke 时再兜底重读盘；全程无 build、无 reload。

## recipe 语法参考

事实源是 `apps/recipe-runner/recipes.schema.json`（draft-07）；本节是它的导读。

### 顶层字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string（必填） | `^[a-z0-9][a-z0-9-]*$`，与文件名一致；launcher / invoke / 热键都靠它寻址 |
| `name` | string | 展示名；缺省用 id |
| `hotkey` | string | 可选全局热键（如 `Ctrl+Alt+R`）；经 `host.hotkey.register` 动态注册，先到先得；注册失败标 `hotkey-conflict`（UI 可见），不阻塞其它配方 |
| `onRun` | `silent \| ask` | 缺省 `silent`：热键 / launcher 触发按取值链静默启动；`ask` 触发先弹参数表单。**required 参数无值时无论何种模式都弹** |
| `params` | object | 启动表单参数（见下） |
| `onerror` | `notify \| silent` | 缺省 `notify`：错误即停后发失败摘要通知（含失败步 id 与错误消息） |
| `limits` | object | 保护参数覆盖：`maxIterations`（缺省 1000）/ `stepTimeoutMs`（30 000）/ `uiStepTimeoutMs`（120 000）/ `runTimeoutMs`（600 000） |
| `steps` | array（必填） | 线性顺序执行的步骤（≥1 步） |

### params（启动表单）

参数名必须是合法 JS 标识符（表达式里以 `params.<名>` 引用）。字段定义：

| 字段 | 说明 |
|------|------|
| `label` | 表单标签；缺省用参数名 |
| `type` | `string \| number \| boolean \| select`（必填） |
| `default` | 声明默认值（取值链最底层） |
| `required` | 必填无值时无论 onRun 何种模式都先弹表单 |
| `options` | `type: select` 时必填：纯字符串或 `{value, label}` 数组 |

**取值链**：per-run override > preset > lastUsed > default。runner 按 recipe 记忆上次表单值
（`params/<id>/lastUsed`），preset 是「另存为 / 套用」的命名参数集（`params/<id>/presets`，
不进 recipe 文件）。param 与 `ui.ask` 的分界：值跨 run 复用 → param（自动获得记忆）；
纯当次上下文 → `ui.ask`（不持久）。

### steps

每步必有全 recipe 唯一的稳定短 id（`^[A-Za-z_$][A-Za-z0-9_$]*$`）——输出引用、错误定位、
AI 指代都靠它。两种形态二选一（schema anyOf 锁死）：

**动作叶子**：

```yaml
- id: list                 # 必填
  action: fs.list          # 必填，动作词表见下节
  args: { dir: "{{params.dir}}", filter: "*.pdf" }   # 实参模板，输入统一写在 args（无 from: 字段）
  out: files               # 可选，输出落点重命名：缺省存 steps.list.out，声明后存 steps.list.files
  when: "{{params.skipConfirm !== true}}"   # 可选：单一 {{ 表达式 }} 或布尔字面量，假值跳过该步
```

**循环容器**（唯一允许的嵌套层，**控制流不套控制流**——体内步骤不得再带 `for`）：

```yaml
- id: ren
  for: { each: r, in: "{{steps.plan.renames}}" }   # 遍历集合（求值结果必须是数组）
  steps:                                            # 或 for: { times: N }（N 为整数或 {{ 表达式 }}）
    - id: one
      action: files.move
      args: { from: "{{r.from}}", to: "{{r.to}}" }  # 循环变量直接进表达式作用域
```

循环变量名不得与 `params` / `steps` / `env` 或 JS 保留字冲突。无 while、无 break——
无界循环 / 中途跳出是升格 app 的信号。容器在轨迹中落一条 `action: "for"` 条目，
子步骤条目带 `iter` 迭代序号（UI 缩进渲染）；循环中断时未开始的迭代不落迹。

## 动作词表（agent 核心参考）

动作两源，判据一句话：**凡改变世界或读屏幕的走 host.\*，纯计算的走 runner util**。
每个动作标注 dry-run 分类，分类即 dry-run 语义：

| 分类 | dry-run 行为 |
|------|--------------|
| mutating | **skip**：不执行，轨迹记 `note`「将做什么」（解析后 args） |
| reading | 照真执行 |
| interactive | 照真执行（模态等用户；走 120s 超时档） |
| notify | 照真执行，实际通知文案加 `[dry-run]` 前缀（前缀不进轨迹） |

### host.\* 直通（args / out 形状以 `src/actions/host.ts` 与 `sdk/src/index.ts` 为准）

| 动作 | dry-run | args | out |
|------|---------|------|-----|
| `clipboard.readText` | reading | — | `string`（剪贴板文本） |
| `clipboard.writeText` | mutating | `{text: string}` | `null` |
| `files.read` | reading | `{path}` | `string`（utf8 全文） |
| `files.write` | mutating | `{path, data: string}` | `null`。只写 utf8，自动建父目录；二进制落盘见「已知限制」 |
| `files.copy` | mutating | `{from, to}` | `null`。目标已存在即报错（`E_EXISTS`，不覆盖） |
| `files.move` | mutating | `{from, to}` | `null`。目标已存在即报错；跨卷自动走「复制→校验→就位→删源」 |
| `files.remove` | mutating | `{path}` | `null`。递归删，force |
| `files.selectFile` | interactive | — | `string \| null`。系统对话框；**取消返回 null 不是错误**，用 `when` 判空走「没选」分支 |
| `files.selectDirectory` | interactive | — | `string \| null`（同上） |
| `screen.capture` | reading | — | `{dataUrl, width, height}`（PNG data URL；坐标 / 尺寸一律物理像素） |
| `screen.captureRegion` | reading | `{rect: {x, y, width, height}}`（四个数字；嵌套对象会被深度解析，数字须整值 `{{ }}` 保类型） | `{dataUrl, width, height}` |
| `screen.selectRegion` | interactive | — | `{x, y, width, height} \| null`。系统截图工具框选（Win+Shift+S 同款）；取消 / 超时返回 null 不是错误 |
| `screen.getMonitors` | reading | — | `[{id, bounds: {x,y,width,height}, scaleFactor, isPrimary}]` |
| `mouse.position` | reading | — | `{x, y}`（物理像素） |
| `mouse.move` | mutating | `{x, y}` | 输入 helper 应答对象（诊断信息，一般不引用） |
| `mouse.click` | mutating | `{x, y, button?}`（button：`left`（缺省）/ `right`） | 同上 |
| `mouse.doubleClick` | mutating | `{x, y}` | 同上 |
| `keyboard.press` | mutating | `{key: string}` | 同上。key 名见下表 |
| `keyboard.hotkey` | mutating | `{keys: string[]}`（如 `["ctrl", "c"]`，非空数组） | 同上 |
| `keyboard.type` | mutating | `{text: string}` | 同上 |
| `notification.show` | notify | `{title, body?, clickCommand?}`（clickCommand 须是本 app 清单命令 id，通常不传） | `boolean`（true = 已展示） |
| `log` | reading | `{msg, level?}`（level：`info`（缺省）/ `warn` / `error`） | `null`（落 `logs/apps/recipe-runner.log`） |
| `process.run` | mutating | `{command, args?: string[], cwd?, env?}` | `{exitCode: number, stdout: string, stderr: string}`（见下） |

**keyboard 的 key 名**（小写；input-helper 键码表）：单字母 `a`–`z`、单数字 `0`–`9`、
`f1`–`f24`、`ctrl` `shift` `alt` `win`、`enter` `esc` `space` `tab` `backspace` `delete`
`insert` `home` `end` `pageup` `pagedown` `up` `down` `left` `right`。

**process.run 详义**：spawn 后阻塞至退出码；stdout / stderr 按行收集后换行拼接。
**非零退出码不是错误**——recipe 用 `when: "{{steps.decode.out.exitCode}} !== 0"` 自行分支；
命令不存在 / 无法 spawn 才走错误即停。取消或步骤超时会 kill 子进程。不设独立超时上限，
计时交 run 剩余预算。

### runner util（`src/actions/util.ts`，全部 reading 类）

| 动作 | args | out |
|------|------|-----|
| `fs.list` | `{dir, filter?}`（filter 是简化 glob：`*` 任意序列 / `?` 单字符，大小写不敏感） | 顶层文件数组（**不含子目录**，按名排序）：`[{path, name, stem, ext, size, mtimeMs}]`；`path` 为正斜杠形式 |
| `text.match` | `{text, pattern, flags?, all?}` | `all: true` → 全部匹配串数组；否则首个匹配串或 `null` |
| `text.replace` | `{text, pattern, replacement, flags?}`（flags 缺省 `"g"`；`$1` 反向引用可用） | 替换后字符串 |
| `json.parse` | `{text}` | 解析后的值（对象 / 数组 / 标量） |
| `http.request` | `{url, method?, headers?, body?, timeoutMs?}`（method 缺省 GET；timeoutMs 缺省 30 000；body 为对象时自动 JSON 序列化） | `{status, ok, headers, body}`（Node fetch） |
| `delay` | `{ms}`（非负数字） | `null`。计时计入 run 总超时；上限 = 剩余 run 预算（超时报「run 总超时」而非步骤超时） |
| `js.eval` | `{code}` | 表达式的值（见「信任模型」） |

`js.eval` 的 code 在完整求值上下文（`params` / `steps` / `env` / 循环变量）里执行，
async 包装——表达式位可直接用 `await` 与 `Promise.all`（「并发取 10 个 URL」是单个动作
内部的事）。全局作用域有 `Buffer`，没有 `require` / `fs`——需要系统能力时用动作词表，
不要试图在 code 里绕。

### ui.\*（交互步骤，`src/actions/ui.ts`）

转发到本 app 窗口的表单（`host.ui` 消息对）；窗口被隐藏则唤起、被销毁则重建
（见「已知限制」）。**用户取消（Esc / 取消按钮）= 错误即停**——这与对话框类
（`files.select*` / `screen.selectRegion` 取消返回 null）刻意区分：对话框选空是合法输入，
confirm / menu 的取消是放弃流程。

| 动作 | args | out |
|------|------|-----|
| `ui.ask` | `{title?, fields}`（fields 形状同 params：`{type, label?, default?, required?, options?}`，数组或 Record 皆可） | `{<字段名>: 值}` 对象；required 缺值在协议层再拦一道 |
| `ui.confirm` | `{title?, body?}` | `true`；用户取消 → 抛「用户取消」走错误即停 |
| `ui.menu` | `{title?, items}`（`string` 或 `{value, label?}` 数组） | 选中的 `value` 字符串；取消即停 |

## agent 生成指引

1. **唯一事实源**：`apps/recipe-runner/recipes.schema.json`（draft-07，ajv 校验同口径）。
   生成后先 `mini invoke recipe-runner check`——`errors` 是 ajv 结构错误（拒），
   `warnings` 是静态扫描（不拒）。不要凭记忆写 schema 字段。
2. **绑定语法**：字符串值内 `{{ 表达式 }}` 插值；**整个值恰为单一 `{{ }}` 时返回原始类型**
   （不字符串化）——类型化引用（数组进 `for.in`、数字进 `rect.x` / 鼠标坐标 / `delay.ms`）
   必须写成整值单一表达式，插值形态会变字符串并在动作边界报错。插值段里 null/undefined
   渲染为空串，对象渲染为 JSON。
3. **引用规范**：可引用的名字只有 `params.*`、`steps.<步骤id>.<out名>`、`env.now`、
   循环变量。out 落点：声明 `out:` 存 `steps.<id>.<out名>`，缺省键名即 `steps.<id>.out`。
   **引用第一段必须是步骤 id**——把 out 名当第一段（bundle 是 out 名却写 `steps.bundle.x`）
   静态扫描会报「引用不存在的步骤 id」且运行时必炸，该警告就是有效信号，改引用而不是忽略它。
4. **表达式语言就是 JS**（`Function` 求值，strict mode）：`when` 与 `for.times` 同语法；
   `when` 必须是单一 `{{ 表达式 }}` 或布尔字面量，结果按 JS 真值判定。
5. **成品即范文**：五个 `recipes/*.yaml` 覆盖了管道、交互确认、循环、宏节拍、二进制落盘
   五种形态；生成新配方前找最接近的改。
6. **环境事实**：Windows；落 JSON / 引用 / 传递的路径一律正斜杠；`fs.list` 的 filter 与
   文件名匹配大小写不敏感；坐标 / 截图全是物理像素。

## 信任模型

`js.eval` 与所有 `{{ }}` 表达式经 `Function` 构造器求值，**等于任意代码执行**。recipe 是
可信内容，信任层级与 App 代码等同（PRD §16：只运行可信内容）——**不做沙箱**，也不打算做。
推论：`recipes/` 是版本库内的可信面，只把经人审阅的 recipe 放进去；来源不明的 YAML
先读一遍再决定。schema 只拦截结构错误，不是安全边界。

## 调试

- **管理窗口**（`mini run recipe-runner` 或 launcher / 托盘唤起）：配方列表（invalid /
  hotkey-conflict 标记、运行中状态）→ 详情页 = 步骤清单 × 轨迹叠加（状态点 / 耗时 /
  循环子步骤缩进；展开看解析后 args 与截断 out）。按钮：运行 / dry-run / 从第 N 步重跑 /
  停止；presets 另存为 / 套用；复制 YAML 路径。在途 run 有直播轨迹（200ms 节流），
  结束后转历史。
- **轨迹存储**：app storage `runs/<recipeId>`，环形保留最近 10 次；`out` 超 4KB 截断
  （记长度与摘要——截图 base64 不落全量）。
- **dry-run**：mutating 动作 skip 且轨迹可见「将做什么」；读取 / 交互 / js.eval 照真。
- **从第 N 步重跑**：以上次 run 各步输出为初始上下文，前序步骤标 `replayed`（args 记声明
  原文）；`fromStep` 只接受顶层步骤 id。UI 按钮 = `rerun {fromStep}`。
- **日志**：`logs/apps/recipe-runner.log`（app log；run 结束有摘要行，热键冲突 / 无效配方
  会记 warn）。
- **fire-and-forget 时序**：`invoke run` 立即返回 `{runId}`，轨迹在 run 结束时才落 storage——
  外部脚本验证需轮询等待，别读到上一次 run 的记录。

## 已知限制与设计边界

1. **并行不存在（设计承诺，非缺失）**：步骤之间永远串行；所有配方（含纯计算型）的 run
   排同一条全局串行链——桌面动作是全局共享状态，任何时刻只允许一条动作链推进。并发只
   允许存在于单个动作内部（`js.eval` 里 `Promise.all`）。同一配方在途时第二个 run 报
   `BUSY`；`stop` 不带 recipe 取消全部在途。
2. **事件监听不在 recipe**：按键 / 剪贴板 / 文件 / 窗口触发属于触发器层（PRD 非目标）。
   判例：键鼠**实时映射**（按键 → 坐标点击、进行期间常开）是独立 app（key-click-mapper，
   P3 候选）；热键触发后执行**固定序列**的一次性宏才是 recipe 领地（`macro-combo`）。
3. **循环受限**：仅 `for: {each, in}` 与 `for: {times}`；无 while、无 break；迭代上限 1000；
   控制流不套控制流。`wait.until`（等条件出现）不在 v0——workaround 是 `for times +
   delay + when`（丑但有限），或升格 app。
4. **二进制落盘要绕**：`files.write` 只写 utf8 文本。链路（`screen-archive` 示范）：
   `js.eval` 剥 base64 → `files.write` 写 `.b64` → `process.run certutil -decode` →
   `files.remove` 清中间文件。
5. **布尔开关会进 last-used**：某次（如 dry-run）传过 `skipConfirm: true` 会被记忆，
   下次不带参数的真跑同样静默跳过确认——这是取值链的正确行为；此类开关应缺省 `false`
   并在注释说明，恢复交互需显式传 `false` 或用 preset 管理。
6. **通知 `[dry-run]` 前缀只改实际文案**，不回写轨迹（轨迹忠实于 recipe 声明）。
7. **窗口探针**（ui.\* 执行时）：隐藏窗口 `focusSelf` 拉回；推一次 state 后 1s 内收到任意
   UI 回包即视为窗口存在直接下发表单，超时才重建 460x560 窗、重建后等 ready（≤8s）再
   下发表单。此前的「每次交互步骤误建一个表单窗」泄漏已由该探针修复——重建只发生在用户
   关掉全部窗口之后。窗口只由用户显式动作关闭，main 不做程序化收起。
8. **错误口径**：动作抛错 / 表达式求值失败 / 超限 = 该步 error、后续标 skipped（错误即停）；
   `process.run` 非零退出码与对话框取消（返回 null）**不是**错误；用户 stop 是 `cancelled`
   不是失败。

## 开发

```bash
cd apps/recipe-runner && npm test     # engine / actions / registry / ui-logic 单测（node --test）
npm run mini -- build recipe-runner   # esbuild + vite 产物（根构建管线）
cd apps/recipe-runner && npm run dev  # vite dev server :5176，重开窗口自动热更
npx tsc --noEmit -p apps/recipe-runner
```

结构：`src/engine/`（parse / interp / trace / expr / params——纯函数核心，动作经注入表，
测试用 fake）；`src/actions/`（host 直通 / runner util / ui 网关——词表的实现事实）；
`src/registry.ts`（扫描解析、热键计划、runId 等编排纯函数）；`src/main.ts`（生命周期 +
热键 + invoke + UI 路由）；`src/ui.tsx` + `src/ui/schema-form.tsx`（React 单向投影；
params 与 `ui.ask` 共用同一 schema→form 渲染器）。Host / CLI / SDK 零改动是本 app 的
交付红线。
