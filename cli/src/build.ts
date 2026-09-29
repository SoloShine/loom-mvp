import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";
import { repoRoot } from "./client";

/**
 * App build pipeline: src/main.ts → dist/main.js (node, cjs) and
 * src/ui.ts (or src/ui.tsx) → dist/ui.js (browser, iife) when present.
 * @mini/sdk is aliased to the host repo's SDK source, so apps never
 * need to install anything before their first run.
 */

function sdkAlias(): Record<string, string> {
  return { "@mini/sdk": path.join(repoRoot(), "sdk", "src", "index.ts") };
}

function newestMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, fs.statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

export function needsBuild(appDir: string): boolean {
  const srcDir = path.join(appDir, "src");
  const outMain = path.join(appDir, "dist", "main.js");
  if (!fs.existsSync(outMain)) return true;
  if (!fs.existsSync(srcDir)) return false;
  return newestMtime(srcDir) > fs.statSync(outMain).mtimeMs;
}

export async function buildApp(appDir: string): Promise<{ uiBuilt: boolean }> {
  const srcMain = path.join(appDir, "src", "main.ts");
  if (!fs.existsSync(srcMain)) {
    throw new Error(`缺少 ${path.relative(repoRoot(), srcMain)}`);
  }
  const dist = path.join(appDir, "dist");
  fs.mkdirSync(dist, { recursive: true });

  await build({
    entryPoints: [srcMain],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: path.join(dist, "main.js"),
    alias: sdkAlias(),
    logLevel: "silent",
    sourcemap: false,
  });

  // ui 入口:ui.ts 优先(既有 App 不变),回退 ui.tsx(react 模板)
  const srcUi = fs.existsSync(path.join(appDir, "src", "ui.ts"))
    ? path.join(appDir, "src", "ui.ts")
    : fs.existsSync(path.join(appDir, "src", "ui.tsx"))
      ? path.join(appDir, "src", "ui.tsx")
      : null;
  if (srcUi) {
    await build({
      entryPoints: [srcUi],
      bundle: true,
      platform: "browser",
      format: "iife",
      target: "chrome120",
      // .tsx(react 模板)经 react/jsx-runtime 转译;对无 JSX 的 vanilla ui.ts 是 no-op
      jsx: "automatic",
      outfile: path.join(dist, "ui.js"),
      alias: sdkAlias(),
      logLevel: "silent",
      sourcemap: false,
    });
    return { uiBuilt: true };
  }
  return { uiBuilt: false };
}
