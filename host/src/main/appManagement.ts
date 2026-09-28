import * as registry from "./registry";
import * as manager from "./runtime/manager";

const operations = new Map<string, Promise<void>>();
export function setEnabledAndReconcile(id: string, enabled: boolean): Promise<void> {
  const prior = operations.get(id) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const app = registry.get(id);
    if (!app) throw new Error(`未知或清单损坏的 App: ${id}`);
    if (app.enabled === enabled) return;
    if (!enabled) await manager.stop(id);
    if (!registry.setEnabled(id, enabled)) throw new Error(`App 不存在: ${id}`);
  });
  operations.set(id, next);
  void next.finally(() => { if (operations.get(id) === next) operations.delete(id); }).catch(() => {});
  return next;
}
