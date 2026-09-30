# Recipe / App 分界原则

> 来源：任务 09-30-recipe-layer（2026-09-30）。接到一个新工具需求、判断该做成 recipe 还是 mini app 时查这里；想给 recipe 层加能力前也查这里。

---

## 两个可判定轴（不是大小，不是寿命）

- **结构复杂度**：需求 = 组合已有动作（词表 + js）→ recipe；需要新算法、控制流想超限、绑定链过长 → 升格 app（代码）
- **交互密度**：流程等人（偶尔确认 / 补参数 / 选区域）→ recipe；人等流程（持久窗口、状态化表单、结果探索）→ app（React 模板）

反例校验：**长期稳定的小 recipe 不必升格**（固定重命名规则用一年仍是 recipe）；**很小的交互密集工具是 app**（一个小面板）。

## 语义阶梯（recipe 永久锁死第 1 级）

```text
1. 线性解释器          ← recipe 层所在（顺序 + when + for，错误即停）
2. 持久化可恢复 run    ← durable execution，从此处起 = 第二个产品
3. 并行分支 / join     ← 桌面动作是全局共享状态，步骤级并行是错误答案
4. 事件触发 / 定时 / 文件监视
5. 可视化画布          ← NON_GOALS（PRD §18）
```

recipe 的永久承诺：步骤间**永远无并行**（并行只允许在单个动作内部，如 js.eval 里 Promise.all）；无 while、无 break；运行有界（缺省总超时 10 分钟，`limits` 可调）。"监控 / 常驻 / 事件驱动"需求不进 recipe，见下。

## 已判案例

- **键 → 坐标点击实时映射**（2026-09-30 用户提出）：事件驱动（按键是触发器）+ 运行无界 + 需全局按键监听原语（host 无，须 helper）→ **app**（key-click-mapper，post-mvp-plan P3.2 候选）；其一次性退化形态（`for times` + keyboard.press / mouse.click / delay 固定序列）→ **recipe**（`apps/recipe-runner/recipes/macro-combo.yaml` 已交付）。
- **事件层演化路径**：当第 2~3 个监控型需求出现（剪贴板 / 文件 / 窗口监控），事件源按 PRD 三问门槛（"≥3 个 App 需要吗"）提升为 host 服务（`keyboard.listen` / `clipboard.onChange` / `fs.watch` / `window.onFocus`），**响应动作复用 recipe 词表**——Quicker 式"持续监控 + 随时配置"由这两层组合而来，loom 分层实现。

## 相关事实

- recipe 是**可信内容**：表达式与 js.eval 经 `Function` 求值 = 任意代码执行，信任等同 app 代码（PRD §16），不沙箱。
- 动作词表、dry-run 分类、轨迹 / 重跑语义、参数取值链详见 `apps/recipe-runner/README.md`（四方对齐的事实源：recipes.schema.json ↔ parse ↔ interp ↔ README）。
