# 手动验收清单

自动化测试(`npm test`,18 项)与 CLI 冒烟覆盖不了的 Windows 真机项,按本清单逐条手动验证。每条通过后建议记录:机器型号、Windows 版本、显示器拓扑(含负坐标与各屏缩放)、Electron/Node/Python 版本、命令全文与退出码。

## 一、管理中心与 Launcher(真机 GUI)

- [ ] 托盘菜单打开管理中心,加载的是 React 版 UI(2026-09-28 接入;深色/浅色切换按钮在顶栏右上角,跟随系统主题,手动选择后刷新/重开保持)。
- [ ] 管理中心核心操作:搜索过滤、列表选择、启动/停止/重载/禁用/启用/收藏,操作后状态与磁盘一致,失败有红色提示。
- [ ] App 详情:权限声明、命令与热键、历史(最近 30 条)与日志(最近 100 行)读取正常。
- [ ] 设置页:Launcher 热键 / 日志保留天数 / 每 App 最大日志容量可保存;非法值(非数字、超范围)失败有提示且状态不变。
- [ ] 修改日志设置(如 `maxLogBytesPerApp`)后,下一条日志立即生效,无需重启 Host。
- [ ] 热键设置改为占用键时提交失败并回滚,旧键仍有效;改回后新键生效。
- [ ] Launcher(`Ctrl+Shift+M`)搜索、收藏排序、启动 App;禁用项有提示且不可启动。
- [ ] 托盘退出后:所有 App 窗口、helper 进程树、全局热键全部释放(任务管理器 + `scripts/list-windows.ps1` 核验)。
- [ ] App 崩溃隔离:手动 kill 某个 App 的 utilityProcess,Host 与其他 App 不受影响,状态变 crash。

## 二、文件整理器(本次新达验收线,PRD §20)

CLI 链路已自动化验证(2026-09-27,对运行中 Host 实测:preview 返回 `total 4 / move 3 / conflict 1`;execute `moved 3 / skipped 1 / failed 0`;冲突目标未被覆盖、子目录未动、日志只记计数)。以下为 GUI 补充:

- [ ] `mini run file-organizer` 打开窗口;Choose directory 弹出系统目录选择器。
- [ ] 预览表格逐行核对:文件名、目标分类、冲突行红色标记。
- [ ] 勾选 Dry Run 时点 Execute:仅刷新预览,无任何文件移动,状态行提示 Dry Run。
- [ ] 取消 Dry Run 点 Execute:确认框 → 移动 → 汇总刷新(moved/skipped/failed),系统通知弹出。
- [ ] 切换规则为「By date (YYYY-MM)」:预览按月份分组;兜底分类输入框隐藏。
- [ ] 规则与上次目录持久化:关闭 App 重开后保留。
- [ ] 非法输入:兜底分类输入中文/超长字符,报错且状态不变。
- [ ] CLI:`mini invoke file-organizer preview` 返回计数;`execute` 返回汇总(未 preview 时 execute 应拒绝)。

## 三、系统对话框、剪贴板与通知(真机)

- [ ] `hello` 自检:`mini invoke hello selftest` 全绿。
- [ ] clipboard-tool:真实复制/粘贴文本;剪贴板为空时的提示;通知实际弹出。
- [ ] screen-inspector:截图(单屏)预览正确;混合 DPI 下截副屏像素正确。
- [ ] 连连看(验收 App 一):系统截图工具选区 → 求解 → 点击,在真实游戏上全流程走一遍(含副屏/跨屏情形);选区取消、超时提示正常。

## 四、多屏 / DPI / 负坐标

本机拓扑:主屏物理 3840×2160 @1.5(DIP 2560×1440),副屏 1920×1200 @1.0。

- [ ] App 窗口拖到副屏后重开,位置/尺寸合理,文字不模糊。
- [ ] 连连看选区与点击在副屏(负坐标或不同缩放)下位置准确。
- [ ] screen-inspector 对两块屏分别截图,像素尺寸 = 物理分辨率。
- [ ] Host 启动时副屏为唯一屏(拔主屏)无异常。

## 五、PRD §21 验收指标对照

| 指标 | 状态 |
| --- | --- |
| 创建 Mini App ≤ 1 分钟 | `mini create` 未计时实测(待验,目标值) |
| 修改 → 生效 ≤ 2 秒 | `mini dev` 未计时实测(待验,目标值) |
| 修改后无需手工操作 Host | 已验证(reload 自动重建过期产物) |
| Runtime Error 可通过 CLI 查看 | 已验证(`mini logs`,错误红字进面板) |
| App Crash 不影响 Host | 自动化有覆盖;真机 kill 待手动确认 |
| 外部 Python Helper 完整 start/stop/log | 已验证(连连看 helper) |
| Window / Floating / Overlay 全部可用 | window/floating 已验证;overlay 待真机确认 |
| Global Hotkey 可注册 | 已验证(Ctrl+Shift+M / Ctrl+Shift+K) |
| Screen / Mouse 可直接调用 | 已验证(连连看全流程) |
| Coding Agent 除 OS 权限外无需操作 Host GUI | 已验证(本轮全程仅 CLI + storage 种子) |
