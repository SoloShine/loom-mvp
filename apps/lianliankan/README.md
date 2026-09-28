# 连连看求解器 (Mini App)

Mini App Host 的第一个验收 App(PRD 第 19 节),从 `D:\Project\lianliankan` 迁移。
在真实屏幕上识别《宠物连连看3.1》棋盘,离线解出连消计划,按序点击并逐对验证,
是 host 截图/点击/进程/存储/通知等 Shared API 的全链路验收载体。

> 本文是 2026-09 当前实现的设计档案 + 后续优化清单。调试快查见文末;
> 更细的踩坑记录在 host 仓库记忆与 `data/logs/`。

## 架构

```text
浮窗「开始/解算」 / Ctrl+Shift+K / mini invoke lianliankan solve|plan
  ↓ host.screen.captureRegion(棋盘区域, 物理像素)
  ↓ stdin JSON Lines (PNG base64)
apps/lianliankan/helper/jsonl_main.py      ← 协议包装(有状态 Session)
  ├─ src/vision/grid_detector.py    行列自动识别
  ├─ src/vision/grid.py             格子切分(TileExtractor)
  ├─ src/vision/empty_detector.py   判空(统计 + 帧环否决 + 背景学习)
  ├─ src/vision/prob_classifier.py  概率聚类分类(无图库,每盘重建)
  └─ src/solver/                    连消路径 BFS + 贪心规划
  ↓ stdout JSON Lines ({board, tiles, moves...})
host.mouse.click × 2 → settle → 逐格重截 → helper verify(判空+背景学习)
```

Python 只依赖 `opencv-python + numpy`(`helper/requirements.txt`,装在 `.venv`);
截图/点击/选区全部由 Host 完成。helper 从源码直跑(改 .py 无需构建,重载 App 即生效)。

## 使用

浮窗按钮:**选区**(系统截图工具框选,自动识别行列)→ **解算**(预演步骤,不下子,
异常就地调参)→ **开始**(执行;再按暂停)/ **停止**。日志区可选中复制,异常红色入日志。
右上角 **✕** = 隐藏面板(状态保留,托盘/启动器唤回;`mini invoke lianliankan hide` 同效)。

```bash
mini run lianliankan                      # 启动/唤起(隐藏的面板会 show 回来)
mini invoke lianliankan select-region     # 框选棋盘
mini invoke lianliankan plan              # 预演
mini invoke lianliankan solve             # 执行
mini invoke lianliankan scan-probe --args '{"with_image": true}'  # 只识别不点击(调试)
mini invoke lianliankan set-grid --args '{"rows":10,"cols":14}'   # 手工改行列
```

区域/行列/阈值存 host.storage,重跑自动恢复。

## 设计

### 网格检测(grid_detector)

边界长直线 → 投影峰 → **格距相位拟合**(真实格距让所有峰落在同一相位网格上,
图块自身尺寸的间距峰会被淘汰)→ 行列数 = 边界跨度 ÷ 格距。两个加固:

- **峰地板 = max(pct60, min(0.08×max, 半条线绝对强度))**。纯相对地板会被
  "某行内容巧合对齐"撑大十几倍,把贴边截图时本就微弱的最外侧边框线误杀
  (10 行判成 9 行的实锤案例);
- **残余条带补行/列**:跨度末端剩 ≥半格距且条带里有图块内容(投影均值 ≥ 盘内
  20%)则 +1 —— 补偿贴边截图外侧线漏检。

行列只在**选区时**(开局满盘,格框线最完整)自动识别;运行中若奇偶校验异常
(>30% 奇),用同帧截图重跑检测**试扫择优**(新行列奇偶严格更优才采纳,
防残局外侧行消空时误纠),见 main.ts `tryHealGrid`。

### 判空(empty_detector)——丰富性检验为主,帧环兜底

主判据就是"块内丰富性检验":**内缩裁剪(80%)方差 < 12 且边缘密度 < 2% → 空格**
(两条件 AND,OR 会把平坦浅色图块误杀)。两层补充:

- **已学背景比对**:verify 确认消除的格子记录其空态外观,此后该格以比对为准;
- **帧环否决**:统计上像空、但**整格外圈 ≥3 条边存在"明显亮于格子中位数"的
  成片框线** → 是图块,并标记 `suspect`。

帧环的存在依据:本类游戏每个图块带**不透明亮色描边框**(空格没有),它是
alpha 混合/选中压暗都摧毁不了的唯一信号;而统计必须用内缩裁剪 —— 整格边缘
会混入邻块描边(实测真空格整格 std 高达 51)。描边框恰好在内缩裁不到的外圈,
所以 scan 时双图分工:内缩图管统计、整格图管帧环。

`suspect`(特征不可信图块)的典型来源:**验证失败后游戏里残留的选中态**
(内芯被压暗、内缩裁剪近均匀,统计判空 → 幽灵空格 → 规划借道它连出游戏
不认的着法)。规划器对所有含 suspect 的着法一律跳过 —— 与现实一致:选中中
的块点击即取消选中,本来就点不成对;它挡路也与现实一致。

### 分类(prob_classifier)——概率模型,无图库

设计约束(用户定调):**不做图标库** —— 换游戏/换分辨率即失效;每盘从当前
截图重建,零迁移。

1. **特征**:Otsu 分割裁到图标外接框(半透明图块的背景不泄漏)→ 32×32 灰度
   模板 + HSV 8×4×4 直方图;相似度 = `0.5×去均值NCC + 0.5×(1-Bhattacharyya)`。
   颜色通道的依据:该游戏不存在同图不同色的图块,颜色不同必为异类。
2. **p_same(相似度)**:全盘两两相似度做两分量高斯 EM。**同类分量中心锚定在
   用户滑块 ±0.10 内**(满盘时异类对占 97%,无锚定的 EM 会坍缩到低区,
   实测 mu1 从 0.9 滑到 0.27 → 全盘狂并)。
3. **概率凝聚聚类**:每次合并 log-odds 增益最大的两簇,合并后成偶数 +0.35、
   奇数 −0.35(连连看每种图案必成对),Δ≤0 停止。

校验:奇偶占比 >30% 警告(可能是识别噪声或错位),>60% 且无着法才拦截。
着法带 `confidence`(两端图块聚类时的 p_same),执行按置信度降序。

### 求解与执行(main.ts + solver)

**计划先行**(用户定调):scan 一次 → helper 在虚拟盘上离线贪心解出完整连消
计划(死局时换前 6 个"第一步"重算取最长)→ 按置信度降序点击 + **逐对验证**
(两次判空机会,间隔等动画)→ 验证失败:该对进排除表、残留选中块标 suspect、
重扫重规划。只有验证失败或计划用尽才重扫,人手动动过盘面自然被重扫同步。
消除成功后重扫若盘面未变小 = 截屏旧帧,重扫一次仍无变化则 STALE 停止。

### 选区(host/screen.ts,宿主基础能力)

默认 = Windows 自带截图工具(`ms-screenclip:`,即 Win+Shift+S):用户在真实
屏幕框选 → 框选图进剪贴板 → host 用 `host/dist/locate-region.py`(cv2
matchTemplate)在整屏物理截图里像素级找回矩形,**零坐标换算**。备用 =
角点点击(PowerShell GetAsyncKeyState 等左键,坐标直读)。截图必须在调起
截图工具**之前**完成(工具遮罩会改变屏幕);抓屏用一次 getSources 取全部
显示器 + 并行写盘(弹窗延迟的主要成分)。

### 窗口(宿主基础能力)

浮窗无系统标题栏。统一关闭语义 = **隐藏到托盘**(`host.window.hide()` /
`close()` 不带参 / 面板 ✕ / `mini invoke <app> hide`):渲染状态保留,
启动器或托盘唤起时 `focusApp` 会 show 回来。销毁仍走 `close(windowId)`
或 `mini stop`。

## 可调参数(thresholds,存于设置)

| 参数 | 默认 | 作用 |
|---|---|---|
| `similarity_threshold` | 0.8 | 分类参考中心 μ(滑块):同类相似度的期望中心,EM 在 ±0.10 内微调。聚成少数巨类→调高;同图案拆散→调低 |
| `tile_inner_ratio` | 0.8 | 格子内缩裁剪比例 |
| `empty_var_threshold` | 12 | 判空方差上限 |
| `empty_edge_threshold` | 0.02 | 判空边缘密度上限 |
| `empty_bg_diff_threshold` | 10 | 已学背景比对容差 |

## 夹具与离线测试

`data/`(仓库根)下的真实盘截图,helper 侧可离线复现全链路:

```bash
cd apps/lianliankan/helper
python -c "from jsonl_main import selftest; print(selftest())"   # 合成图自检
python   # → Session({'rows':10,'cols':14,...}).scan({image_b64, origin}) + solve_board({})
```

| 夹具 | 内容 | 基准(2026-09-27) |
|---|---|---|
| `board-live-140.png` | 用户真实满盘 10×14,origin 211,369 | 30 类/0 奇/0 空(30 簇目检全单一物种) |
| `board-112.png` | 残局 112 块 28 空,origin 213,371 | 34 类/0 奇;仅 1 步可走属实(暴力 BFS 对拍) |
| `board-74.png` | 残局 74 块 | 29 类/0 奇 |
| `board-now2.png` | 满盘(内含 2 块选中态) | 33 类/2 奇(选中块特征损坏,即 suspect 场景) |

改判空/分类/网格代码后,以上基准 + selftest 必须零回归。

## 已知局限与后续优化清单

- **规划器**:贪心 + 6 次换首步,残局常给出部分计划(DEADLOCK → 执行完重扫
  续解,功能正确但步数不优)。可做:随机重启贪心、终局(≤12 块)精确搜索、
  按奇偶/位置启发排序首步。
- **选中态残留**:suspect 只是规避(不配对、当障碍),面板会提示但块仍被
  选中占用。若确认游戏"点击已选中块=取消选中"的语义,可在验证失败后自动
  补一次点击取消选中,下一扫描即可复原。
- **置信度未校准**:EM 的 p_same 偏乐观(修正后满盘置信度普遍 1.0)。
  confidence 的"降序执行"价值依赖它有区分度,可用 verify 结果回料做在线
  校准(失败对 → 同簇对打标)。
- **系统性错位自纠不全**:行列错了能自动纠(奇偶试扫),但页面缩放/滚动
  造成的平移错位仍需人工重新「选区」。可从帧环网格相位反推平移量自动纠。
- **性能**:全盘 O(n²) 相似度 + 凝聚在 140 块盘约 1.7s。可下采样特征、
  numpy 向量化 NCC、或对近邻剪枝。
- **背景学习覆盖**:learn-background 只学点击过的格子;可扩展为整盘空态
  背景建模(空格亮度/纹理模式),辅助判空。
- **特殊皮肤/动画**未验证:颜色直方图依赖图案主色稳定,换肤/闪烁类图案
  需重验。

## 调试速查

| 症状 | 先查 |
|---|---|
| 识别数 ≠ rows×cols 或大量奇数 | 面板日志行列自纠提示;区域错位(滚动/换关)→ 重新选区;`scan-probe` 看网格 |
| 点击了空背景 / 预览不刷新 | desktopCapturer 旧帧(已有双取帧+盘面收缩防线);仍复发截 host.log |
| 反复点同一对失败 | 排除表/suspect 是否生效(helper 日志);选中态残留提示 |
| 解算步骤明显荒谬 | 先看识别类型数是否合理(对照目测);调参考中心 μ;`scan-probe` 导出 board |
| 面板消失 | 全屏游戏盖住置顶层 → 托盘/`mini run` 唤回;运行中隐藏过 → 同上 |
| 选区调不出/匹配失败 | 遮挡或截图后屏幕变化;角点选区备用;`data/logs/host.log` 搜 selectRegion |
