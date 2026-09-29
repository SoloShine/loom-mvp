import path from "node:path";
import fs from "node:fs";
import { host } from "@mini/sdk";
import {
  applyPlan, buildPlan, isSafeDirectory, isValidCategory, isValidRuleMode,
  topLevelFiles, type ExecuteResult, type Plan, type RuleMode,
} from "./rules";

const MAX_TABLE_ITEMS = 1000;

let directory: string | null = null;
let mode: RuleMode = "extension";
let fallback = "Other";
let plan: Plan | null = null;
let lastResult: ExecuteResult | null = null;

function state() {
  const items = plan ? plan.items.slice(0, MAX_TABLE_ITEMS) : [];
  host.ui.send({
    type: "state",
    directory,
    mode,
    fallback,
    plan: plan ? { counts: plan.counts, items, truncated: plan.items.length > items.length } : null,
    lastResult,
  });
}
function failure(error: unknown) {
  host.ui.send({ type: "error", message: error instanceof Error ? error.message : String(error) });
  void host.log.warn("file-organizer operation failed");
}

async function scan(): Promise<void> {
  if (!directory) throw new Error("Select a directory first");
  if (!isSafeDirectory(directory)) throw new Error("Refusing to organize a drive root");
  const dirents = fs.readdirSync(directory, { withFileTypes: true });
  const files: { name: string; mtimeMs: number }[] = [];
  for (const name of topLevelFiles(dirents)) {
    try {
      files.push({ name, mtimeMs: fs.statSync(path.join(directory, name)).mtimeMs });
    } catch {
      // Vanished between readdir and stat; leave it out of the plan.
    }
  }
  plan = buildPlan({ directory, files, mode, fallback, destinationExists: (p) => fs.existsSync(p) });
}

async function chooseDirectory() {
  const selected = await host.files.selectDirectory();
  if (!selected) return;
  const resolved = path.resolve(selected);
  if (!isSafeDirectory(resolved)) throw new Error("Refusing to organize a drive root");
  directory = resolved;
  plan = null;
  lastResult = null;
  await host.storage.set("lastDir", directory);
  await scan();
  state();
}

async function updateSettings(nextMode: unknown, nextFallback: unknown) {
  if (!isValidRuleMode(nextMode)) throw new Error("Invalid rule mode");
  if (!isValidCategory(nextFallback)) throw new Error("Invalid fallback category");
  mode = nextMode;
  fallback = nextFallback;
  await host.storage.set("mode", mode);
  await host.storage.set("fallback", fallback);
  if (directory) await scan();
  state();
}

async function execute() {
  if (!plan || !directory) throw new Error("Preview a directory before executing");
  if (plan.directory !== directory || plan.mode !== mode || plan.fallback !== fallback) {
    throw new Error("Plan is stale; refresh the preview first");
  }
  const result = await applyPlan(plan, (from, to) => host.files.move(from, to), {
    destinationExists: (p) => fs.existsSync(p),
    isFile: (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
    sameVolume: (a, b) => path.parse(a).root.toLowerCase() === path.parse(b).root.toLowerCase(),
  });
  lastResult = result;
  await host.log.info(
    `file-organizer moved ${result.moved}, skipped ${result.skipped.length}, failed ${result.failed.length} in ${directory} (${result.durationMs}ms)`,
  );
  if (result.moved > 0) {
    const targets = [...new Set(result.movedList.map((m) => path.dirname(m.destination)))];
    const summary = targets.length <= 3 ? targets.join("、") : `${targets.length} 个分类文件夹`;
    await host.notification.show({
      title: "File Organizer",
      body: `已移动 ${result.moved} 个文件到 ${summary}${result.skipped.length + result.failed.length ? `,跳过 ${result.skipped.length + result.failed.length} 个` : ""}`,
      clickCommand: "show",
    }).catch(() => false);
  }
  await scan();
  state();
  return result;
}

async function loadSettings() {
  const savedMode = await host.storage.get("mode");
  if (isValidRuleMode(savedMode)) mode = savedMode;
  const savedFallback = await host.storage.get("fallback");
  if (isValidCategory(savedFallback)) fallback = savedFallback;
  else {
    const legacy = await host.storage.get("category");
    if (isValidCategory(legacy)) fallback = legacy;
  }
  const savedDir = await host.storage.get("lastDir");
  if (typeof savedDir === "string" && isSafeDirectory(savedDir) && fs.existsSync(savedDir)) directory = savedDir;
}

export async function onStart() {
  await loadSettings();
  await host.log.info("file-organizer started");
}
export async function onStop() { await host.log.info("file-organizer stopped"); }

export async function invoke(command: string) {
  if (command === "preview") {
    if (!directory) throw new Error("No directory selected yet; run the app once and choose one");
    await scan();
    state();
    return plan?.counts ?? null;
  }
  if (command === "execute") {
    const result = await execute();
    return { moved: result.moved, skipped: result.skipped.length, failed: result.failed.length };
  }
  if (command === "show") {
    await host.window.focusSelf();
    return null;
  }
  throw new Error(`Unknown command: ${command}`);
}

host.ui.onMessage((message: any) => {
  void (async () => {
    switch (message?.type) {
      case "ready":
        if (directory) await scan();
        state();
        break;
      case "directory": await chooseDirectory(); break;
      case "settings": await updateSettings(message.mode, message.fallback); break;
      case "scan": await scan(); state(); break;
      case "execute":
        // Apply current UI settings first so the plan can never execute stale rules.
        await updateSettings(message.mode, message.fallback);
        await execute();
        break;
    }
  })().catch(failure);
});
