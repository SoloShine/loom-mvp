/**
 * 窗口几何恢复的可见性校验与钳制。纯计算,无 electron 依赖,可契约测试。
 * 手改 host-state 的旧数据不可信(跨屏 DIP 原点 × 主屏 scale 的坑),恢复前
 * 必须过这里:结构非法、或与所有显示器工作区零相交(显示器拔了/坐标完全过期)
 * 返回 null,调用方回退默认位置;有相交则钳到相交最大的那个工作区内。
 * saved / workArea / 返回值全程同一 DIP 空间,不做物理像素换算。
 */
export function sanitizeRestoredBounds(
  saved: unknown,
  displays: { workArea: { x: number; y: number; width: number; height: number } }[],
): { x: number; y: number; width: number; height: number } | null {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
  const b = saved as Record<string, unknown>;
  if (typeof b.x !== "number" || typeof b.y !== "number" || typeof b.width !== "number" || typeof b.height !== "number" ||
    !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.width) || !Number.isFinite(b.height) ||
    b.width < 1 || b.height < 1) return null;
  if (displays.length === 0) return null;
  let best: { workArea: { x: number; y: number; width: number; height: number } } | undefined;
  let bestArea = 0;
  for (const d of displays) {
    const ix = Math.max(b.x, d.workArea.x);
    const iy = Math.max(b.y, d.workArea.y);
    const iw = Math.min(b.x + b.width, d.workArea.x + d.workArea.width) - ix;
    const ih = Math.min(b.y + b.height, d.workArea.y + d.workArea.height) - iy;
    const area = iw > 0 && ih > 0 ? iw * ih : 0;
    if (area > bestArea) {
      bestArea = area;
      best = d;
    }
  }
  if (!best) return null;
  const wa = best.workArea;
  const width = Math.min(b.width, wa.width);
  const height = Math.min(b.height, wa.height);
  const x = width >= 64
    ? Math.min(Math.max(b.x, wa.x - width + 64), wa.x + wa.width - 64)
    : Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width);
  const y = height >= 48
    ? Math.min(Math.max(b.y, wa.y - height + 48), wa.y + wa.height - 48)
    : Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}
