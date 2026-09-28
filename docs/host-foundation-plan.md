# Host 基础设施升级实施方案

## 目标与现状依据

本方案针对 Windows 10/11 x64 的个人桌面工具宿主，保留外部 Coding Agent 通过 `mini` 完成创建、运行、调试的路径；Host 只提供基础设施，不承载 App 业务（`docs/loom-mvp-prd.md:2-12`、`docs/loom-mvp-prd.md:138-155`、`README.md:0-31`）。这是一项现有 MVP 的增量升级，不重做 runtime、SDK 或 Launcher。

| 现状 | 依据 | 本次处理 |
| --- | --- | --- |
| 扫描 `apps/*`，坏清单保留 broken；`registry.json` 仅记录 disabled，内存 Map 保存清单和状态 | `host/src/main/registry.ts:38-49`、`host/src/main/registry.ts:88-106`、`host/src/main/registry.ts:113-175` | 持久化用户 App 元数据，扫描结果仍来自磁盘，分离清单与用户状态 |
| Manifest 有 `permissions: string[]`，未校验权限枚举；服务分发直接按 service/method 调用 | `host/src/main/manifest.ts:90-107`、`host/src/main/services/dispatcher.ts:19-30`、`host/src/main/services/dispatcher.ts:169-172` | 如实展示声明与未声明情况，不声称已实现安全授权 |
| 控制通道是 127.0.0.1 随机端口 + token，已有 App 读写/启停/调用；Launcher IPC 仅有列表/启动/调用 | `host/src/main/controlChannel.ts:8-15`、`host/src/main/controlChannel.ts:58-115`、`host/src/main/launcher.ts:135-161` | 扩展相同控制面，不新增网络服务；管理页使用受限 preload |
| per-App 存储是 `data/storage/<id>.json`，同步读、临时文件重命名；日志同步追加 `host.log` 和 `<id>.log`，helper 输出进入 App 日志 | `host/src/main/services/core.ts:54-95`、`host/src/main/logging.ts:10-45`、`host/src/main/services/processSvc.ts:33-52` | 保持 SDK 存储语义与日志路径，增设有界查询和历史索引 |
| 进程状态仅在内存中，崩溃提示并写日志；CLI `logs` 直接读仓库 `data/logs`，控制通道发现也直接读仓库 `data/runtime.json` | `host/src/main/runtime/manager.ts:19-45`、`host/src/main/runtime/manager.ts:288-311`、`cli/src/index.ts:192-217`、`cli/src/client.ts:18-24` | 记录运行与命令历史，统一 CLI/Host 的数据目录解析 |
| Launcher 是 520×400 的 palette，搜索 App 和命令；没有设置、详情、历史管理页 | `host/src/main/launcher.ts:115-165`、`host/src/launcher/ui.ts:29-60`、`host/src/launcher/ui.ts:94-120` | 保留 palette，另开轻量管理窗口 |

PRD 期望启停/reload/删除注册、最近使用与收藏、设置和运行历史（`docs/loom-mvp-prd.md:251-290`、`docs/loom-mvp-prd.md:294-329`）；权限第一版只声明展示，不做复杂审批（`docs/loom-mvp-prd.md:808-840`）。本方案不把权限标签解释成沙箱。当前 App 窗口 `sandbox: false`，且 `files` 与 `process.spawn` 可访问本机资源（`host/src/main/services/windows.ts:18-31`、`host/src/main/services/core.ts:17-43`、`host/src/main/services/processSvc.ts:19-30`）。

## 数据与所有权

选择 **文件存储 + Host 单写者**，暂不引入 SQLite 或原生模块打包。PRD 允许 JSON，且明确 MVP 不需要数据库迁移系统（`docs/loom-mvp-prd.md:279-290`）；现有持久化即 JSON（`host/src/main/registry.ts:38-49`、`host/src/main/services/core.ts:54-95`）。按负载和数据损坏情况复盘后再决定是否迁 SQLite。文件布局沿用 `paths.data` 与 `MINI_DATA_DIR`（`host/src/main/config.ts:6-28`）：

```text
data/
  registry.json             # 现有格式：根对象 {"disabled": string[]}，迁移期间只读
  host-state.json           # schemaVersion, settings, apps[id] 的用户元数据
  active-runs.json          # 原子写入的启动 epoch 与 active run 快照
  history.jsonl             # append-only run/invoke 事件；定期归档/截断
  logs/host.log             # 保持现有路径
  logs/apps/<id>.log        # 保持 mini logs 可用
  storage/<id>.json         # SDK App 私有 KV，不混入宿主设置
  runtime.json              # 临时发现文件；不进入备份/历史
```

`host-state.json` 初始结构：`schemaVersion: 1`；`settings` 含 `launcherHotkey`（默认 `Ctrl+Shift+M`）、`launchAtLogin`（默认 false，若本批不实现系统登录启动则不展示该项）、`logRetentionDays`（默认 14）、`maxLogBytesPerApp`（默认 10 MiB）；`apps[id]` 含 `enabled`、`favorite`、`addedAt`、`lastUsedAt`、`useCount`。只持久化用户态，不复制 `name/version/commands/permissions`，这些每次从清单解析；`status` 由 runtime 计算；broken 项也能关联已有用户元数据但不可运行。`lastUsedAt/useCount` 在成功启动或成功 invoke 后更新，失败不计；收藏仅影响排序，未收藏按最近使用后名称排序，搜索相关度仍优先。删除注册在扫描式 Registry 下定义为**移除用户元数据并停用 App**（可选“从列表隐藏”仅隐藏，不删除目录）；要彻底卸载由用户在文件系统管理目录，管理 UI 不提供删目录按钮。若目录重新扫描出现，恢复默认未收藏、启用状态；隐藏若实现须持久化且有“显示隐藏项/恢复”。避免把“删除注册”误做物理删除（扫描逻辑见 `host/src/main/registry.ts:89-106`）。

`active-runs.json` 结构固定为 `{schemaVersion: 1, epoch: string, runs: [{runId, appId, startedAt, pid}]}`。每次 Host 启动生成新 epoch；`manager.start` 在创建 UtilityProcess、写 history start 前先以临时文件+flush/close+同目录 rename 写入 active run，成功 stop/crash 后先清除该项再写终结事件。启动扫描上一个 epoch 的遗留项，按 `runId` 追加一次 `interrupted`（带 `reason: "host-exit"`），然后清空旧 active 集合；当前 epoch 的写入失败是可观测错误：不承诺“异常退出必标记 interrupted”，本次启动/启停操作按失败返回并不创建未登记 run，直到状态文件可写。历史写失败仍只告警，不得阻断既有 crash/cleanup 路径；所有 active-runs 写入失败、恢复和重复 eventId 都记录 host 日志并可重试。该文件与 history 分离，不能用内存 `runs` 推断 Host 重启后的有效 run。

宿主状态通过单一 Store 顺序化写入：先校验并更新内存副本，写同目录临时文件，flush/close 后 rename，Windows rename 失败保留旧文件并返回错误；写入期间按队列串行化。启动时解析和版本检查；坏文件移至带时间戳的旁路副本并以安全默认值启动，记录显眼错误，不默默覆盖；未来 `schemaVersion` 大于当前版本时只读并禁用修改，不降级覆盖。`history.jsonl` 每条含 `eventId`、`appId`、`runId`、`kind`（start/stop/crash/interrupted/invoke）、`at`、`command?`、`outcome`、`durationMs?`、`exitCode?`、`message?`；不记录 invoke args、返回值、剪贴板、屏幕内容或 helper 原始数据。一次运行以 `runId` 关联 start/stop/crash/interrupted，命令另记 invoke 结果；启动失败也记 start failure。Host 异常退出后的未终结 run 只依据 `active-runs.json` 标记 `interrupted`，不误报 crash。写事件失败只告警、不阻断启停；读取跳过尾部不完整行并记录诊断。设历史上限（例如近 30 天或 10,000 条，以先到者为准），原子压缩到新文件；查询只读取有界页，不向 renderer 发送整文件。

## 设置、App 管理与权限

设置只包括确定能生效的宿主级选项：Launcher 热键、日志保留天数/容量、启动时是否恢复上次运行 App（默认 false；若实现须明确已禁用/broken 不恢复）；允许重置为默认，变更热键由 hotkeys service 统一执行 `register-new -> commit -> unregister-old`：先注册新值成功才提交 Store 和内存 owner，冲突/注册失败保留旧值；提交后的旧值释放失败进入可重试告警，不释放新值。Launcher 的 host owner 也必须登记在同一 owners Map，`reservedByHost()` 返回当前 host combo；`initLauncher` 不得直接调用 `globalShortcut.register/unregister`，`shutdownLauncher` 只请求统一 hotkeys shutdown，before-quit 不得重复释放。Host 启动注册默认/持久化热键失败时保持无热键并回退设置，不抢占 App 绑定；reload/退出均由同一服务幂等清理。设置采用字段白名单、范围校验和单写者，拒绝未知字段与路径字段。

App 详情显示：清单 ID、名称/版本、目录、UI 类型、命令、热键、运行状态、manifestIssues、启用、收藏、最近运行、使用次数，以及声明权限。启用/禁用必须经过 Host service 的统一 `setEnabledAndReconcile(id, enabled)` 入口，CLI、palette、App 热键和 control API 不得直接改 Registry。启用先提交用户态并刷新 Registry；禁用若 App 未运行可直接提交，若运行中则进入内存 `stopping` 状态，先调用 `manager.stop`，等待进程退出并完成 hotkey/helper/window cleanup，成功后才提交 `enabled=false`；stop 超时/失败则保持 `enabled=true` 和运行状态，返回可重试错误，不出现“持久化 disabled 但进程仍运行”。重试必须幂等，Host 重启扫描 active-runs 后按真实进程状态恢复/终结。`manager.start`、`manager.invoke`、`requireApp` 以及 palette/App 热键的解析均调用同一 enabled 检查；状态枚举至少包含 `running|stopping|stopped|crashed|broken`，UI 显示 stopping 而非伪装 stopped。当前 `setEnabled` 只改标志（`host/src/main/registry.ts:167-175`），`manager` 的停止清理在 `host/src/main/runtime/manager.ts:289-319`，阶段 2 必须把编排放在 Host service 而不是把 stop 逻辑复制到入口。broken 和清单缺产物要以具体错误展示，启动前校验 entry/dist；不把 `manifestIssues` 当成“权限拒绝”。目录消失或清单变化时刷新详情/托盘/搜索并保留用户元数据，不依赖当前只在 palette 显示时刷新（`host/src/main/registry.ts:118-135`、`host/src/main/launcher.ts:71-83`）。

权限界面按 `screen.capture`、`mouse.control`、`process.spawn` 等 manifest 字符串分组、中文解释并突出未知项；无声明显示“未声明”，不可显示“已授权/已隔离”。使用“本地 App 的能力声明，当前版本不强制拦截 host.*；只运行可信代码”的明确提示；安装/首次启用时展示一次摘要，但本地 `mini dev` 不增加阻塞对话。当前解析器只过滤字符串（`host/src/main/manifest.ts:90-92`），可在 `mini validate` 对未知能力给 warning，不静默丢弃；若后续要做实际权限强制，需要独立威胁模型和调用方归属/服务映射审计，不属于本期。管理页只能管理宿主；不能把 `host.*` 的服务分发暴露给管理 renderer。

## 日志与运行历史

继续维护纯文本日志和 `mini logs <id> --follow` 契约（`docs/loom-mvp-prd.md:588-624`、`cli/src/index.ts:192-217`）。新建 Host 侧只读日志查询 `appId`、`cursor`、`limit`、`level`（文本日志格式容错解析，helper 行标记 stream），响应返回行、下一游标与是否有更多；默认尾部 200 行、最大 500 行/次、最大响应字节数，历史页提供按时间/结果筛选及关联日志跳转。初期无需全量日志索引，按当前文件从尾部读有界窗口；若日志查询性能不足再做轻量索引。按日期/大小轮转并保留最近 N 天/总容量；轮转以 rename + 新文件进行，`mini logs --follow` 需识别 inode/文件替换、缺失与截断并从新文件继续，且遵循 `MINI_DATA_DIR`。限制单行/敏感数据的 UI 显示长度；日志本身可能含 App 自行打印的隐私，UI 不上传、不默认导出。历史事件和日志存储分开，删除历史不会删除 App 存储；提供清空历史/日志的分别确认操作，先明确作用范围。

## 管理 UI 与 API

保留 `Ctrl+Shift+M` palette 的键盘启动体验，在托盘和 palette 增加“管理”入口，另开固定最小尺寸、可缩放的 BrowserWindow。页面使用紧凑的左侧 App 列表 + 右侧详情/日志/历史，设置独立页；搜索、收藏、状态筛选，禁用项不可启动，broken 可看错误；操作后显示进行中、成功/错误状态，空列表、无历史、日志不可读均有明确状态。采用当前原生 DOM + CSS/TS 构建模式（`host/src/launcher/ui.ts:63-92`、`host/src/preload/launcher.ts:0-12`），不为管理页引入整套前端框架。保持 contextIsolation，受限 preload 暴露有类型的管理方法；主进程逐次校验 `webContents` 属于管理窗口与参数，IPC 不能复用 `mini:svc` 的 App 能力入口（`host/src/main/index.ts:38-51`）。

控制通道保持现有 bearer token 和 loopback，仅增加版本化语义明确的路由，不开远程访问（`host/src/main/controlChannel.ts:118-143`）。建议：`GET /settings`、`PATCH /settings`；`GET /apps` 延伸 `favorite/lastUsedAt/useCount`、`GET /apps/:id` 返回详情；`POST /apps/:id/enable|disable|favorite|unfavorite`、`POST /apps/:id/stop|start|reload` 沿用；`GET /apps/:id/history?cursor=&limit=`、`GET /apps/:id/logs?cursor=&limit=`；`GET /history?cursor=&limit=`；仅在明确删除注册语义后增加 `DELETE /apps/:id/registration`。响应统一 `{ok, data?, error?: {code,message}}` 可先兼容现有 `{ok, apps/app/result}`，新增端点用规范结构，CLI client 在过渡期同时解析两种；参数限制（ID 必须存在且匹配解析 ID、分页上限、body 大小/超时），不接受任意文件路径；不在 URL、日志或错误回显 token。所有 enable/disable、start/invoke、palette/App 热键动作都调用同一 Host service；control channel 只做 schema 校验和调用，不直接写 Registry。`runtime.json` 含 token，进程本地文件需限制为当前用户可读并避免进入同步/备份（`host/src/main/controlChannel.ts:138-141`、`cli/src/client.ts:18-24`）；该 token 不是多用户隔离保证。CLI 增加 `mini settings get/set`、`mini info <id>`、`mini enable/disable <id>`、`mini favorite/unfavorite <id>`、`mini history [id]`，日志仍可在 Host 不运行时读本地文件；管理动作需要运行 Host 并沿用 `ensureHost`。保持脚本友好：成功 JSON 输出选项、错误非零退出码、不弹管理页。

Electron 退出只由一个有界、幂等的 shutdown coordinator 编排：先阻止新管理/控制请求，再停止运行中的 App 并等待 helper、窗口、App 热键清理，随后 flush Store/history、关闭 watcher/control channel、统一释放 host/App hotkeys，最后退出；每一步有超时、错误告警和最多一次重试，超时后仍继续后续清理。`before-quit` 只触发一次 coordinator 并阻止并发调用，`will-quit` 仅完成已注册的同步兜底释放；不得由 Launcher、管理窗口或各 service 各自注册退出清理。其顺序覆盖现有 `before-quit` 未等待 `manager.stopAll()` 的竞态（`host/src/main/index.ts:76-90`）。

## 迁移、兼容与回退

1. 在引入新状态文件前备份 `data/registry.json` 和 `data/storage/`（不移动或重写 App KV）；备份与源文件同目录、带 UTC 时间戳，记录大小和 SHA-256，校验失败则停止迁移。启动时若缺 `host-state.json`，只读取 `paths.registryFile`（即 `data/registry.json`）的根对象；仅当 JSON 合法且 `disabled` 为 `string[]` 时，将其中 ID 合并到 `apps[id].enabled=false`，缺失文件、缺失 `disabled` 或非法根结构均按空集合并记录诊断，绝不读取/假设 `registry.json.disabled` 文件。迁移测试必须以 `{disabled:["id"]}` 的真实格式验证旧项仍禁用，并覆盖缺失/非法结构。迁移使用幂等标记（源文件指纹、schemaVersion 和 `migratedFrom`），原子落盘后保留旧文件作回退；重复启动不得重复合并或用扫描默认值覆盖用户态。迁移失败停止写入并告警，不能把所有 App 自动启用。
2. `paths.data` 作为唯一 Host 数据目录；CLI 的 `runtimeInfo`、`logs` 先改用同一配置规则 `MINI_DATA_DIR` 优先、否则 `MINI_ROOT/data`，离线命令也从相同文件读（现有 CLI 固定仓库 `data`，`host/src/main/config.ts:6-28` 对环境变量有不同处理，见 `cli/src/client.ts:18-24`、`cli/src/index.ts:192-193`）。不在本批迁移数据到 OS 用户目录，以免改变安装布局。
3. 新代码先双读旧/新 registry，单写新文件；一个版本周期保留旧文件，不由新代码自动删除；回退旧 Host 前应停止新 Host，校验并人工恢复迁移前同目录备份，再启动旧 Host，因为旧 Host 不读取新文件。`storage/<id>.json`、现有日志路径与 SDK 方法不变；新 history/active-runs 文件可被旧 Host 忽略。
4. 新旧日志格式兼容解析，轮转先以 feature flag/默认关闭上线；CLI follow 支持轮转后再默认开启，避免升级导致跟随卡住。缺失/非法配置展示明确恢复提示和备份路径。

## 分批实施与验收

| 阶段 | 交付及依赖 | 验收门槛 |
| --- | --- | --- |
| 1. 数据契约与迁移 | 抽出 Host/CLI 共用路径规则、定义 state/history/active-runs 类型和验证、原子写入、旧 `paths.registryFile` 根对象 `disabled: string[]` 导入与带校验备份；建立 Host 单写者与迁移幂等标记 | 用临时 `MINI_ROOT/MINI_DATA_DIR/MINI_APPS_DIR` 执行 Node test runner：真实 `{disabled:["id"]}` 仍禁用；缺失/非法根结构不启用全部 App；重复启动不覆盖用户态；断电/rename 失败保留旧文件；`MINI_DATA_DIR` 的 Host/CLI 一致 |
| 2. App 管理与设置 | Registry 在一次扫描中读取旧 disabled 并合并 host-state 用户态；Host service 编排 `setEnabledAndReconcile`、统一 start/invoke/热键/control 入口；运行中禁用 stop 成功后提交；收藏/最近使用、设置白名单；host owner 纳入 hotkeys owners，热键 register-new/commit/unregister-old 与回滚 | Node test runner 覆盖 disabled 从 CLI、palette、App 热键和 control API 均不能启动，stop 失败时仍 enabled/running 且可重试，重新启用可运行；热键冲突保留旧绑定、Launcher reload/退出无双重释放；目录扫描与用户状态独立 |
| 3. 运行历史与日志 | active-runs 原子 start/clear/epoch 扫描与 `interrupted` 事件；集中 shutdown coordinator；lifecycle/invoke 事件、崩溃与异常退出标记、有界分页；日志读取 API；CLI 日志轮转兼容后启用留存 | Node test runner 覆盖 Host 重启扫描遗留 active run 只标记一次 interrupted、active-runs 写失败的明确失败语义、crash 后 Host 仍活；日志滚动时按文件身份切换，`--follow` 不漏/不重复/不无限读内存；helper stdout/stderr 每行一次 |
| 4. 管理 UI 与权限展示 | 独立管理窗口、受限 preload、双重 sender/参数校验、列表/详情/设置/历史/日志；权限摘要与未知项警示；托盘入口；所有退出清理接入 coordinator | `npm run build`；Electron 临时目录 smoke 验证管理 preload 不能调用 `mini:svc`、broken 可查看原因、所有写操作错误态和列表实时更新；退出时等待 App/helper 清理且不重复释放 |
| 5. 回归与发布 | Windows 10/11 x64、多屏/混合 DPI 的既有功能回归；迁移演练、CLI 文档更新、备份完整性与人工回退说明 | 先执行 `npm run build`，预期输出含 `build ok`；再执行 `npm test`（当前 package 无该脚本，预期在实现测试脚本前以缺失脚本失败并记录，不得冒充通过）；实现后执行 `npm test` 全量、Electron smoke，以及 Windows 多显示器/混合 DPI 人工验收，覆盖 PRD CLI 无 GUI、崩溃隔离、helper start/stop/log 和两验收 App 关键路径（`docs/loom-mvp-prd.md:924-967`、`docs/loom-mvp-prd.md:1036-1067`、`docs/loom-mvp-prd.md:1071-1107`） |

测试实施：当前根脚本只有 build/host/mini、未定义 test 脚本（`package.json:10-24`）；新增 Node 内置 test runner 的数据层/路由/CLI 单元与集成测试，不把 build 当测试。覆盖真实 registry 根对象 `{disabled: string[]}` 迁移、缺失/非法结构、高版本与损坏文件、迁移幂等和同目录备份校验；覆盖 active-runs 的 epoch、原子写入失败、Host 重启 interrupted 去重；覆盖并发更新顺序、扫描 broken/目录变化、统一禁用入口及 stop 补偿、host/App 热键所有权和 register-new/commit/unregister-old；覆盖分页截断/异常行、日志轮转文件身份、helper stdout/stderr、CLI 数据目录覆盖。Electron 端做独立临时 `MINI_ROOT/MINI_DATA_DIR/MINI_APPS_DIR` 的进程级 smoke：管理 preload 归属、App crash 不影响 Host、helper 退出和两类 App；最后在实际 Windows 多显示器/混合 DPI 环境人工复测既有截图、鼠标与窗口路径。每阶段执行新增全量测试和 `npm run build`；当前审查已实际执行 `npm run build`，输出包含 `build ok`，该检查通过；已实际执行 `npm test`，输出 `npm error Missing script: "test"` 且退出码 1，当前不能声称测试通过。Electron smoke、Node test runner、新增测试和 Windows 人工验收本次未运行，必须在实现后按上述规模执行；本文件仅是方案。

## 明确非目标

不做插件市场/评分/商业分发、账号、云同步、自动更新、AI Chat 或内置 Coding Agent、Git 管理、远程控制、多人协作、跨平台完整支持（`docs/loom-mvp-prd.md:884-918`）。不做复杂沙箱或把声明式权限伪装为强制授权；不做管理员权限提升、App 目录物理删除、全量日志搜索引擎、通用数据库迁移框架、复杂窗口布局或重写 SDK。上述范围以外的能力应由具体 Mini App 保持独立实现，遵循 Host API 至少有跨 App 复用价值的原则（`docs/loom-mvp-prd.md:1236-1242`）。
