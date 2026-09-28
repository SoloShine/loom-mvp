import path from "node:path";
import fs from "node:fs";

// host/dist/main/index.js → repo root is three levels up
const rootDir = path.resolve(__dirname, "..", "..", "..");

export const paths = {
  root: process.env.MINI_ROOT ?? rootDir,
  get apps() {
    return process.env.MINI_APPS_DIR ?? path.join(this.root, "apps");
  },
  get data() {
    return process.env.MINI_DATA_DIR ?? path.join(this.root, "data");
  },
  get logs() {
    return path.join(this.data, "logs");
  },
  get appLogs() {
    return path.join(this.data, "logs", "apps");
  },
  get storage() {
    return path.join(this.data, "storage");
  },
  get runtimeFile() {
    return path.join(this.data, "runtime.json");
  },
  get registryFile() {
    return path.join(this.data, "registry.json");
  },
  get hostDist() {
    return path.join(this.root, "host", "dist");
  },
  get bootstrapPath() {
    return path.join(this.hostDist, "runtime", "bootstrap.cjs");
  },
  get appWindowPreload() {
    return path.join(this.hostDist, "preload", "app-window.cjs");
  },
  get locateRegionScript() {
    return path.join(this.hostDist, "locate-region.py");
  },
  // 截图区域定位用的 python(需要 opencv);可用环境变量覆盖
  get locateRegionPython() {
    return process.env.MINI_PYTHON ?? "python";
  },
  get launcherPreload() {
    return path.join(this.hostDist, "preload", "launcher.cjs");
  },
  get managementPreload() {
    return path.join(this.hostDist, "preload", "management.cjs");
  },
  get inputHelper() {
    return path.join(this.hostDist, "input-helper.ps1");
  },
};

export function initDataDir(): void {
  for (const dir of [paths.data, paths.logs, paths.appLogs, paths.storage]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
