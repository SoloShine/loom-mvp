import { build } from "esbuild";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const r = (...p) => path.join(root, ...p);

const nodeCommon = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: false,
  logLevel: "silent",
};

await mkdir(r("host/dist/preload"), { recursive: true });
await mkdir(r("host/dist/management"), { recursive: true });
await mkdir(r("host/dist/runtime"), { recursive: true });
await mkdir(r("cli/dist"), { recursive: true });

await Promise.all([
  // Electron main process
  build({
    ...nodeCommon,
    entryPoints: [r("host/src/main/index.ts")],
    external: ["electron"],
    outfile: r("host/dist/main/index.js"),
  }),
  // Preload scripts (sandboxed: only electron builtins used)
  build({
    ...nodeCommon,
    entryPoints: [r("host/src/preload/app-window.ts")],
    external: ["electron"],
    outfile: r("host/dist/preload/app-window.cjs"),
  }),
  build({
    ...nodeCommon,
    entryPoints: [r("host/src/preload/launcher.ts")],
    external: ["electron"],
    outfile: r("host/dist/preload/launcher.cjs"),
  }),
  build({
    ...nodeCommon,
    entryPoints: [r("host/src/preload/management.ts")],
    external: ["electron"],
    outfile: r("host/dist/preload/management.cjs"),
  }),
  // Launcher palette UI
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    logLevel: "silent",
    entryPoints: [r("host/src/launcher/ui.ts")],
    outfile: r("host/dist/launcher/ui.js"),
  }),
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome120",
    sourcemap: false,
    logLevel: "silent",
    entryPoints: [r("host/src/management/ui.ts")],
    outfile: r("host/dist/management/ui.js"),
  }),
  // CLI (esbuild + electron stay external: esbuild locates its binary
  // relative to its own package dir; electron resolves the exe at runtime)
  build({
    ...nodeCommon,
    entryPoints: [r("cli/src/index.ts")],
    external: ["electron", "esbuild"],
    outfile: r("cli/dist/mini.js"),
  }),
]);

// Management UI: the React renderer in ui/ is the production page whenever
// its toolchain is installed; the legacy esbuild page stays as the fallback
// (remove ui/node_modules to force it). Vite emits a classic IIFE script and
// an external stylesheet; here we normalize the Vite HTML for file:// + strict
// CSP (no module scripts, no crossorigin, CSP meta injected at copy time).
const viteBin = r("ui", "node_modules", "vite", "bin", "vite.js");
const reactManagement = existsSync(viteBin);
if (reactManagement) {
  const res = spawnSync(process.execPath, [viteBin, "build"], { cwd: r("ui"), stdio: "inherit" });
  if (res.status !== 0) throw new Error("ui renderer build failed");
  await rm(r("host/dist/management"), { recursive: true, force: true });
  await mkdir(r("host/dist/management"), { recursive: true });
  await cp(r("ui", "dist"), r("host/dist", "management"), { recursive: true });
}

for (const page of ["management", "launcher"]) {
  if (page === "management" && reactManagement) {
    const built = await readFile(r("host/dist/management/index.html"), "utf8");
    let out = built.replace(
      /<script type="module" crossorigin src="(.*?)"><\/script>/,
      '<script defer src="$1"></script>',
    );
    if (out === built) throw new Error("management renderer: Vite script tag not found");
    out = out.replace(/<link rel="stylesheet" crossorigin href="(.*?)">/, '<link rel="stylesheet" href="$1">');
    const csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\';">';
    out = out.replace(/<meta charset="UTF-8"\s*\/>/, `<meta charset="UTF-8" />${csp}`);
    if (!out.includes("Content-Security-Policy")) throw new Error("management renderer: CSP not injected");
    await writeFile(r("host/dist/management/index.html"), out);
    continue;
  }
  const html = await readFile(r("host/src", page, "index.html"), "utf8");
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  if (!match) throw new Error(`${page} missing stylesheet`);
  await writeFile(r("host/dist", page, "style.css"), match[1]);
  const strict = html.replace(match[0], '<link rel="stylesheet" href="./style.css">');
  await writeFile(r("host/dist", page, "index.html"), strict);
}
await copyFile(r("host/src/runtime/bootstrap.cjs"), r("host/dist/runtime/bootstrap.cjs"));
// .ps1 必须带 BOM:Windows PowerShell 5.1 对无 BOM 的 UTF-8 按 ANSI/GBK
// 解码,脚本里的中文注释会把解析搞乱(曾把函数内赋值整行吞掉)。
await copyWithBom(r("host/src/main/services/input-helper.ps1"), r("host/dist/input-helper.ps1"));
await copyFile(r("host/src/main/services/locate-region.py"), r("host/dist/locate-region.py"));

// stamp version into the bundle source of truth
const pkg = JSON.parse(await readFile(r("package.json"), "utf8"));
await writeFile(r("host/dist/version.json"), JSON.stringify({ version: pkg.version }, null, 2));

console.log("build ok");

async function copyWithBom(src, dest) {
  const buf = await readFile(src);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  await writeFile(dest, hasBom ? buf : Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
}
