/**
 * @mini/sdk — Mini App Host SDK
 *
 * All host.* APIs are async (they cross IPC). The SDK is provided by the
 * running Host: it is bundled into the Mini App at build time via esbuild
 * alias and talks to the Host over the runtime MessagePort (app process)
 * or over the window preload bridge (app UI).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** PNG data URL + pixel size. Coordinate space: physical pixels everywhere. */
export interface CapturedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface MonitorInfo {
  id: number;
  bounds: Rect;
  scaleFactor: number;
  isPrimary: boolean;
}

export interface SpawnOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SpawnHandle {
  pid: number;
  /** one callback per line, newline stripped */
  stdout(cb: (line: string) => void): () => void;
  stderr(cb: (line: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  write(data: string): Promise<void>;
  kill(): Promise<void>;
  /** resolves with the exit code once the process is gone */
  wait(): Promise<number | null>;
}

interface RendererBridge {
  call(service: string, method: string, args?: unknown): Promise<unknown>;
  appSend(msg: unknown): void;
  onAppMessage(cb: (msg: unknown) => void): void;
  onSvcEvent(cb: (m: SvcEvent) => void): void;
}

interface SvcEvent {
  key: string;
  event: string;
  data: unknown;
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

const rendererBridge: RendererBridge | undefined =
  typeof window !== "undefined" ? (window as any).__miniHost : undefined;

const nodePort: any =
  typeof process !== "undefined" && !!(process as any).parentPort
    ? (process as any).parentPort
    : undefined;

let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(m: SvcEvent) => void>>();

function dispatchEvent(m: SvcEvent) {
  const set = listeners.get(m.key);
  if (set) for (const fn of [...set]) {
    try {
      fn(m);
    } catch {
      /* listener errors never break the host */
    }
  }
}

if (nodePort) {
  nodePort.on("message", (e: any) => {
    const m = e?.data ?? e;
    if (!m || typeof m !== "object") return;
    if (m.type === "mini-svc-res") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error ?? "host call failed"));
    } else if (m.type === "mini-svc-event") {
      dispatchEvent(m as SvcEvent);
    }
  });
}

if (rendererBridge) {
  rendererBridge.onSvcEvent(dispatchEvent);
}

function subscribe(key: string, cb: (m: SvcEvent) => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

function call(service: string, method: string, args?: unknown): Promise<any> {
  if (rendererBridge) return rendererBridge.call(service, method, args);
  if (nodePort) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      nodePort.postMessage({ type: "mini-svc", id, service, method, args });
    });
  }
  return Promise.reject(
    new Error(`@mini/sdk: host.${service} 只能运行在 Mini App Host 内(未找到传输通道)`),
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function spawnHandle(res: { handleId: string; pid: number }): SpawnHandle {
  const id = res.handleId;
  const exitWait = new Promise<number | null>((resolve) => {
    subscribe(`${id}:exit`, (m: any) => resolve(m.data?.code ?? null));
  });
  return {
    pid: res.pid,
    stdout(cb) {
      return subscribe(`${id}:stdout`, (m: any) => cb(m.data?.line ?? ""));
    },
    stderr(cb) {
      return subscribe(`${id}:stderr`, (m: any) => cb(m.data?.line ?? ""));
    },
    onExit(cb) {
      return subscribe(`${id}:exit`, (m: any) => cb(m.data?.code ?? null));
    },
    write: (data: string) => call("process", "write", { handleId: id, data }),
    kill: () => call("process", "kill", { handleId: id }),
    wait: () => exitWait,
  };
}

// ---------------------------------------------------------------------------
// host API
// ---------------------------------------------------------------------------

export const host = {
  /** app-scoped logging, lands in logs/apps/<appId>.log */
  log: {
    info: (msg: string) => call("log", "info", { msg }),
    warn: (msg: string) => call("log", "warn", { msg }),
    error: (msg: string) => call("log", "error", { msg }),
  },

  /** per-app namespaced key/value storage, host manages isolation */
  storage: {
    get: (key: string) => call("storage", "get", { key }),
    set: (key: string, value: unknown) => call("storage", "set", { key, value }),
    delete: (key: string) => call("storage", "delete", { key }),
    keys: (): Promise<string[]> => call("storage", "keys"),
  },

  clipboard: {
    readText: (): Promise<string> => call("clipboard", "readText"),
    writeText: (text: string) => call("clipboard", "writeText", { text }),
  },

  files: {
    read: (path: string): Promise<string> => call("files", "read", { path }),
    write: (path: string, data: string) => call("files", "write", { path, data }),
    copy: (from: string, to: string) => call("files", "copy", { from, to }),
    move: (from: string, to: string) => call("files", "move", { from, to }),
    remove: (path: string) => call("files", "remove", { path }),
    selectFile: (): Promise<string | null> => call("files", "selectFile"),
    selectDirectory: (): Promise<string | null> => call("files", "selectDirectory"),
  },

  screen: {
    capture: (): Promise<CapturedImage> => call("screen", "capture"),
    captureRegion: (rect: Rect): Promise<CapturedImage> =>
      call("screen", "captureRegion", { rect }),
    selectRegion: (): Promise<Rect | null> => call("screen", "selectRegion"),
    getMonitors: (): Promise<MonitorInfo[]> => call("screen", "getMonitors"),
  },

  mouse: {
    position: (): Promise<{ x: number; y: number }> => call("mouse", "position"),
    move: (x: number, y: number) => call("mouse", "move", { x, y }),
    click: (x: number, y: number, button: "left" | "right" = "left") =>
      call("mouse", "click", { x, y, button }),
    doubleClick: (x: number, y: number) => call("mouse", "doubleClick", { x, y }),
    /**
     * 全局等待下一次左键点击,返回点击处的真实屏幕物理坐标。
     * 适用于"点两个角定区域"这类零转换选区;Esc 取消 / 超时返回标记。
     */
    waitClick: (): Promise<
      { x: number; y: number; cancelled?: false; timeout?: false } |
      { cancelled: true; x?: undefined; y?: undefined } |
      { timeout: true; x?: undefined; y?: undefined }
    > => call("mouse", "waitClick"),
  },

  keyboard: {
    press: (key: string) => call("keyboard", "press", { key }),
    hotkey: (keys: string[]) => call("keyboard", "hotkey", { keys }),
    type: (text: string) => call("keyboard", "type", { text }),
  },

  /** dynamic hotkeys; MVP: prefer declaring hotkeys in app.yaml */
  hotkey: {
    register: async (combo: string, cb: () => void): Promise<boolean> => {
      const key = `hotkey:${combo}`;
      const ok: boolean = await call("hotkey", "register", { combo, key });
      if (ok) subscribe(key, () => cb());
      return ok;
    },
    unregister: (combo: string) => call("hotkey", "unregister", { combo }),
  },

  /** extra windows beyond the manifest-declared one */
  window: {
    create: (opts: { type?: "window" | "floating" | "overlay"; width?: number; height?: number }) =>
      call("window", "create", { opts }),
    /** 关闭窗口:带 windowId 销毁指定窗口;不带 = 隐藏本 App 全部窗口
     *  (浮窗面板"✕"的语义:状态保留,启动器/托盘可唤回) */
    close: (windowId?: string) => call("window", "close", { windowId }),
    /** 隐藏本 App 的全部窗口(不销毁,可随时唤回) */
    hide: () => call("window", "hide", {}),
    /** 把本 App 的窗口拉回最前(全屏游戏处于全屏层,会盖住置顶浮窗) */
    focusSelf: () => call("window", "focusSelf", {}),
  },

  notification: {
    show: (opts: { title: string; body?: string }) => call("notification", "show", opts),
  },

  process: {
    /** raw stream access; stdout/stderr are also tee'd into the app log */
    spawn: async (opts: SpawnOptions): Promise<SpawnHandle> =>
      spawnHandle(await call("process", "spawn", { opts })),

    /** convenience for JSON Lines helpers; non-JSON lines are dropped */
    spawnJson: async <T = any>(
      opts: SpawnOptions,
    ): Promise<{ handle: SpawnHandle; onMessage: (cb: (msg: T) => void) => () => void }> => {
      const handle = await host.process.spawn(opts);
      const onMessage = (cb: (msg: T) => void) =>
        handle.stdout((line) => {
          try {
            cb(JSON.parse(line) as T);
          } catch {
            /* helper may print plain logs; ignore non-JSON lines */
          }
        });
      return { handle, onMessage };
    },
  },

  /**
   * App runtime → its window(s) message bus.
   * Only available in the app runtime process (node side).
   */
  ui: {
    send: (msg: unknown) => {
      void call("window", "sendToUi", { msg }).catch(() => {});
    },
    onMessage: (cb: (msg: any) => void) =>
      subscribe("ui:message", (m: any) => cb(m.data)),
  },

  /**
   * Window → app runtime message bus.
   * Only available inside the app window (renderer side).
   */
  app: {
    send: (msg: unknown) => {
      if (!rendererBridge) throw new Error("host.app 只能在 App 窗口(渲染进程)内使用");
      rendererBridge.appSend(msg);
    },
    onMessage: (cb: (msg: any) => void) => {
      if (!rendererBridge) throw new Error("host.app 只能在 App 窗口(渲染进程)内使用");
      rendererBridge.onAppMessage(cb);
    },
  },
};

export default host;
