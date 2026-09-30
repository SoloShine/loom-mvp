/**
 * App 运行内存观测的纯解析:从 `app.getAppMetrics()` 快照按 pid 精确对号。
 * electron-free(入参用最小结构类型,不 import electron 类型),可契约测试 bundle 直跑。
 * 按 pid 对号天然排除 Host 自身/渲染/GPU 等 Electron 其它进程;App 用 SDK
 * process.spawn 起的 helper 子进程不是 Electron 进程,快照里不可见。
 * 只观测不回收:无上限回收、无告警、无历史;任何脏输入跳过或返回 undefined,绝不抛。
 *
 * 实测(Electron 44):ProcessMetric.memory = { workingSetSize, peakWorkingSetSize,
 * privateBytes },单位 KB——旧文档的 { workingSetMB } 形状并不存在;两种形状都收,
 * workingSetSize 按 KB→MB 换算,跨版本健壮。
 */
export interface ProcessMetricLite {
  pid?: unknown;
  memory?: { workingSetSize?: unknown; workingSetMB?: unknown };
}

function resolveWorkingSetMB(memory: ProcessMetricLite["memory"]): number | undefined {
  if (!memory) return undefined;
  if (typeof memory.workingSetSize === "number" && Number.isFinite(memory.workingSetSize)) {
    return Math.round(memory.workingSetSize / 1024);
  }
  if (typeof memory.workingSetMB === "number" && Number.isFinite(memory.workingSetMB)) {
    return Math.round(memory.workingSetMB);
  }
  return undefined;
}

/**
 * 在 metrics 快照里找 pid 相等且 working set 为有限数的第一条,返回 MB 整数;
 * pid 非有限数 / 未命中 / 全脏 → undefined。
 */
export function memoryForPid(pid: unknown, metrics: unknown): number | undefined {
  if (typeof pid !== "number" || !Number.isFinite(pid)) return undefined;
  if (!Array.isArray(metrics)) return undefined;
  for (const entry of metrics as (ProcessMetricLite | null | undefined)[]) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.pid !== pid) continue;
    const workingSetMB = resolveWorkingSetMB(entry.memory);
    if (workingSetMB !== undefined) return workingSetMB;
  }
  return undefined;
}
