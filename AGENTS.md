<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

# 全局 MCP 工具约定(fff 与 codegraph)

本机已全局接入两个 MCP server。搜索与理解代码优先用它们,替代盲扫式的内置 Glob/Grep 循环;两者都不覆盖的场景再用内置工具。

## codegraph —— 代码理解与改动前定位(首选)

依据:官方 README(colbymchenry/codegraph)——只暴露一个强工具,「几乎所有问题都先 reach for codegraph_explore」。

- **任何结构性问题、以及动手改代码之前,先调 `codegraph_explore`**:某符号如何工作、调用链("X 如何到达 Y")、某区域架构梳理、即将改动的符号是什么。一次调用按文件分组返回相关符号的**逐字源码** + 调用路径 + 影响面(blast radius)。
- 返回的源码**视为已读**,不要再 grep/Read 复核一遍;通常零文件读取即可作答。
- 查询可以是自然语言,也可以是符号/文件名堆(如 `AuthService loginUser session-manager`);`maxFiles` 控制返回文件数(默认 12);查其他已索引项目传 `projectPath`。
- 索引在 `.codegraph/`(SQLite),watcher 自动同步(默认 2s 防抖),重连时自动补同步。**编辑后若响应带 staleness 标记,说明该文件待同步——直接 Read 它拿实时内容**,不要用旧索引。手动维护:`codegraph sync`(增量)、`codegraph status`(看待同步)、`codegraph index --force`(全量重建)。

## fff —— 文件名与内容搜索(替代内置 Glob/Grep)

依据:官方 README(dmtrKovalenko/fff)推荐原文:"For any file search or grep in the current git-indexed directory, use fff tools."(仓库中任何文件搜索或 grep 都用 fff)

- `find_files`(文件名/路径模糊搜索):**查询保持 1~2 个词**;多个词是逐级收窄(瀑布),不是 OR;支持路径前缀(`src/`)与 glob 约束(`!test/`、`*.{ts,tsx}`);结果按 frecency(常用 + 最近打开)排序,git 变更文件有标注。
- `grep`(内容搜索):**一次只给一个具体词**,搜裸标识符(如 `InProgressQuote`),不要写成代码语法或正则;用约束收窄范围(如 `*.rs query`、`src/ query`);精确零命中自动转模糊,`.*` 式纯通配模式会被拒绝;结果多时用 cursor 翻页。
- `multi_grep`(多模式 OR):一次扫多种命名风格(snake_case + PascalCase 一起给),配 `constraints`(如 `*.{ts,tsx} !test/`)与 `context` 上下文行数。
- 约束语法:`git:modified|staged|deleted|renamed|untracked|ignored`;`test/` 表示其深层子目录;`!排除` 文本至少 3 个字符;支持 glob(`./**/*.{rs,lua}`);grep 独有:扩展名过滤(`*.md`)与单文件限定(`src/main.rs`)。

分工:理解代码/找符号/评估改动影响 → codegraph;找文件、正则之外的内容搜索 → fff。
