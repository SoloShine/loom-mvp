# P2.3 会话恢复(默认关)

## 背景

Host 猝死(崩溃/强杀/断电)后,下次启动 `history.initRuns()` 会给 active-runs 里无终态的 run 逐个补 `interrupted` 事件,但 App 不会回来,用户要手动逐个重启。roadmap P2.3:加一个默认关闭的设置开关,打开后 boot 时自动恢复。

## 目标

1. 设置页新增「启动时恢复上次运行的 App」开关,默认关;旧 host-state.json 缺该字段时迁移为关,不误判损坏。
2. 开关打开时,Host 启动完成后自动重新 start 本次 boot 被标 interrupted 的 App;单项失败(目录被删/禁用/清单损坏/启动超时)不阻塞其余。
3. 每次恢复尝试向 history 写一条 `restored` 事件(success/failure),结果同时进 host 日志。
4. 关闭开关时行为与现状完全一致(只标 interrupted,不恢复)。

## 非目标

- 不做「还原现场」:恢复 = 重新 start,App 内未落盘状态不保留;窗口几何由 P2.1 持久化接管,与崩溃前瞬间无关。
- 正常关闭(mini host --shutdown、托盘退出)不恢复——那些路径 App 有终态 stop 事件,initRuns 不会标 interrupted,天然不触发,无需新逻辑。
- 不做按 App 的恢复白名单/排除配置,只有全局开关。
- SDK 动态窗口、App 自起的 helper 进程由各自既有生命周期负责,Host 不额外恢复。

## 验收标准

1. 开开关 → 启动两个 App → taskkill 强杀 Host → 重启:两 App 自动回到 running,各有一条 restored success 事件,窗口正常显示(几何按 P2.1 恢复)。
2. 同场景关开关重启:两 App 保持 stopped,只有 interrupted 事件(现状行为)。
3. 恢复名单中含已删除/已禁用的 App 时:该 App 写 restored failure(带原因)且不影响其余 App 恢复。构造:强杀后、重启前删掉某 App 目录,或 Host 停止期间改 host-state.json 禁用。
4. restored 事件不干扰 run 终态判定:恢复后的 run 正常 stop 时 stop 事件照写。

## 用户可见行为

- 设置页「常规」卡新增一行开关与说明文案。
- 恢复动作在 host.log 有逐条日志;管理中心 App 详情 history 可见 restored 事件。
