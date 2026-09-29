// dev 模式 UI 热更(ui.devUrl)的窗口加载目标决策。
// 可达判定:收到任何 HTTP 响应即算可达(不判 res.ok——SPA dev server 对部分路径
// 回 404 不影响页面加载);连接拒绝/超时 = 不可达。

async function defaultProbe(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(400) });
    return true;
  } catch {
    return false;
  }
}

/** 声明了 devUrl 且探测可达 → "dev"(loadURL 接 HMR);未声明/不可达 → "artifact" 回退产物。 */
export async function resolveDevTarget(
  devUrl: string | undefined,
  probe: (url: string) => Promise<boolean> = defaultProbe,
): Promise<"dev" | "artifact"> {
  if (!devUrl) return "artifact";
  return (await probe(devUrl)) ? "dev" : "artifact";
}
