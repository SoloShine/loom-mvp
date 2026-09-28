import type { Settings } from "./state";

/** 某个 App 当前被哪条闲置回收规则管着、时长来自清单还是全局默认。 */
export interface IdleStopPolicy {
  minutes: number;
  source: "manifest" | "global";
}

/** 下发给管理界面的闲置回收信息(manifest.ts 会丢弃清单里的 0,故 manifestMinutes 不含 0)。 */
export interface IdleStopInfo {
  manifestMinutes?: number;
  /** 在设置页例外名单中,永不自动回收。 */
  exempt: boolean;
  /** 当前实际生效的策略;null = 不会自动回收。 */
  effective: IdleStopPolicy | null;
}

/**
 * 闲置回收生效规则:总开关关→不回收;例外名单→不回收;
 * 清单声明优先,其次全局默认时长(0 = 只回收清单声明过的 App)。
 * 单个 App「明确不要回收」走设置页例外名单,不靠清单里的 0(解析层会把 0 丢弃)。
 */
export function effectiveIdleStop(
  appId: string,
  manifestMinutes: number | undefined,
  settings: Pick<Settings, "recycle">,
): IdleStopPolicy | null {
  const recycle = settings.recycle;
  if (!recycle?.enabled) return null;
  if (recycle.exemptAppIds.includes(appId)) return null;
  if (manifestMinutes && manifestMinutes > 0) return { minutes: manifestMinutes, source: "manifest" };
  return recycle.defaultMinutes > 0 ? { minutes: recycle.defaultMinutes, source: "global" } : null;
}

/** 控制通道与管理窗口共用的序列化;参数取结构最小集,避免牵入 registry 运行时依赖。 */
export function describeIdleStop(
  e: { id: string; manifest?: { lifecycle?: { idleStopMinutes?: number } } },
  settings: Pick<Settings, "recycle">,
): IdleStopInfo {
  const manifestMinutes = e.manifest?.lifecycle?.idleStopMinutes;
  return {
    manifestMinutes,
    exempt: !!settings.recycle?.exemptAppIds.includes(e.id),
    effective: effectiveIdleStop(e.id, manifestMinutes, settings),
  };
}
