import * as state from "./state";
import { configureLogging } from "./logging";

let queue: Promise<state.Settings> = Promise.resolve({ ...state.defaults });
let updateHotkey: ((next: string, commit: () => void) => void) | null = null;

export function configureSettingsCommitter(fn: (next: string, commit: () => void) => void): void { updateHotkey = fn; }

export function patchHostSettings(patch: unknown): Promise<state.Settings> {
  queue = queue.catch(() => state.settings()).then(() => {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("设置必须是对象");
    const before = state.settings();
    const candidate = { ...before, ...(patch as Record<string, unknown>) };
    let committed = false;
    const commit = () => { state.patchSettings(patch); committed = true; };
    try {
      if (Object.hasOwn(patch, "launcherHotkey")) {
        if (!updateHotkey) throw new Error("Launcher 设置暂不可用");
        updateHotkey(String((patch as any).launcherHotkey), commit);
      } else commit();
      if (!committed) throw new Error("设置未提交");
      configureLogging(candidate as state.Settings);
      return state.settings();
    } catch (error) {
      try {
        if (JSON.stringify(state.settings()) !== JSON.stringify(before)) {
          state.patchSettings(before);
          configureLogging(before);
        }
      } catch { /* preserve original failure */ }
      throw error;
    }
  });
  return queue;
}
