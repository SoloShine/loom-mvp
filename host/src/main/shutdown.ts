export type ShutdownPhase = "running" | "draining" | "finalizing" | "ready";

export function createShutdownCoordinator(deps: {
  drain(): void;
  activeIds(): string[];
  stop(id: string): Promise<void>;
  force(id: string): void;
  isActive(id: string): boolean;
  waitForExit(id: string): Promise<void>;
  finalize(results: { appId: string; outcome: "stopped" | "timeout" | "failure"; error?: string }[]): void;
  quit(): void;
  log(message: string): void;
}, budgetMs = 12_000) {
  let phase: ShutdownPhase = "running";
  let pending: Promise<void> | undefined;
  const results: { appId: string; outcome: "stopped" | "timeout" | "failure"; error?: string }[] = [];
  function beforeQuit(event: { preventDefault(): void }): void {
    if (phase === "ready") return;
    event.preventDefault();
    if (pending) return;
    phase = "draining";
    deps.drain();
    pending = (async () => {
      const deadline = Date.now() + budgetMs;
      for (const appId of deps.activeIds()) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) { deps.force(appId); results.push({ appId, outcome: "timeout" }); continue; }
        let timer: NodeJS.Timeout | undefined;
        try {
          const outcome = await Promise.race([
            deps.stop(appId).then(() => "stopped" as const),
            new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), remaining); }),
          ]);
          if (outcome === "timeout") deps.force(appId);
          results.push({ appId, outcome });
        } catch (error) {
          deps.force(appId);
          results.push({ appId, outcome: "failure", error: String(error) });
        } finally { if (timer) clearTimeout(timer); }
      }
      for (const result of results) {
        if (result.outcome === "stopped" || !deps.isActive(result.appId)) continue;
        const end = Date.now() + 1000;
        await Promise.race([deps.waitForExit(result.appId), new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, end - Date.now())))]);
        if (deps.isActive(result.appId)) deps.log(`SHUTDOWN_INCOMPLETE: ${result.appId} process exit unconfirmed`);
      }
      phase = "finalizing";
      deps.finalize(results);
    })().catch((error) => deps.log(`SHUTDOWN_INCOMPLETE: ${String(error)}`)).finally(() => {
      phase = "ready";
      deps.quit();
    });
  }
  return { beforeQuit, get phase() { return phase; }, get results() { return [...results]; }, get pending() { return pending; } };
}
