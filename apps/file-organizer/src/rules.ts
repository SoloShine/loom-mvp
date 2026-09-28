import path from "node:path";

// Pure planning logic for the file organizer: no SDK, no fs. main.ts wires
// real fs/Host calls in; tests run this module against fake and real fs.

export type RuleMode = "extension" | "date";

export interface PlanItem {
  source: string;
  fileName: string;
  category: string;
  destination: string;
  /** Destination already exists; execution must skip, never overwrite. */
  conflict: boolean;
}

export interface Plan {
  directory: string;
  mode: RuleMode;
  fallback: string;
  items: PlanItem[];
  counts: { total: number; move: number; conflict: number };
}

export interface ExecuteResult {
  moved: number;
  skipped: { fileName: string; reason: string }[];
  failed: { fileName: string; error: string }[];
  durationMs: number;
}

export const EXTENSION_CATEGORIES: Record<string, string> = {
  ".txt": "Documents", ".md": "Documents", ".pdf": "Documents", ".doc": "Documents",
  ".docx": "Documents", ".rtf": "Documents", ".odt": "Documents",
  ".jpg": "Images", ".jpeg": "Images", ".png": "Images", ".gif": "Images",
  ".webp": "Images", ".bmp": "Images", ".svg": "Images",
  ".csv": "Data", ".json": "Data", ".xlsx": "Data", ".xml": "Data",
  ".zip": "Archives", ".7z": "Archives", ".rar": "Archives", ".tar": "Archives", ".gz": "Archives",
  ".mp4": "Videos", ".mov": "Videos", ".avi": "Videos", ".mkv": "Videos",
  ".mp3": "Audio", ".wav": "Audio", ".flac": "Audio",
};

export function isValidCategory(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(value);
}

export function isValidRuleMode(value: unknown): value is RuleMode {
  return value === "extension" || value === "date";
}

export function classifyByExtension(fileName: string, fallback: string): string {
  return EXTENSION_CATEGORIES[path.extname(fileName).toLowerCase()] ?? fallback;
}

/** Local-time "YYYY-MM" bucket; Downloads-style grouping reads best in local time. */
export function classifyByDate(mtimeMs: number): string {
  const d = new Date(mtimeMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Only plain top-level files are eligible; directories and symlinks are never touched. */
export function topLevelFiles(
  dirents: { name: string; isFile(): boolean; isSymbolicLink(): boolean }[],
): string[] {
  return dirents.filter((d) => d.isFile() && !d.isSymbolicLink()).map((d) => d.name);
}

/** Refuse drive roots so one mis-click cannot mass-move an entire volume. */
export function isSafeDirectory(dir: string): boolean {
  const resolved = path.resolve(dir);
  return resolved !== path.parse(resolved).root;
}

export function buildPlan(opts: {
  directory: string;
  files: { name: string; mtimeMs: number }[];
  mode: RuleMode;
  fallback: string;
  destinationExists: (p: string) => boolean;
}): Plan {
  const items: PlanItem[] = [];
  for (const f of opts.files) {
    const category =
      opts.mode === "date" ? classifyByDate(f.mtimeMs) : classifyByExtension(f.name, opts.fallback);
    const source = path.join(opts.directory, f.name);
    const destination = path.join(opts.directory, category, f.name);
    items.push({ source, fileName: f.name, category, destination, conflict: opts.destinationExists(destination) });
  }
  const conflict = items.filter((i) => i.conflict).length;
  return {
    directory: opts.directory,
    mode: opts.mode,
    fallback: opts.fallback,
    items,
    counts: { total: items.length, move: items.length - conflict, conflict },
  };
}

export async function applyPlan(
  plan: Plan,
  move: (from: string, to: string) => Promise<void>,
  checks: {
    destinationExists: (p: string) => boolean;
    isFile: (p: string) => boolean;
    sameVolume: (a: string, b: string) => boolean;
  },
): Promise<ExecuteResult> {
  const started = Date.now();
  const skipped: ExecuteResult["skipped"] = [];
  const failed: ExecuteResult["failed"] = [];
  let moved = 0;
  for (const item of plan.items) {
    // Re-check at execution time: the plan may be stale by the time it runs.
    if (!checks.isFile(item.source)) { skipped.push({ fileName: item.fileName, reason: "source missing or not a regular file" }); continue; }
    if (checks.destinationExists(item.destination)) { skipped.push({ fileName: item.fileName, reason: "destination exists" }); continue; }
    if (!checks.sameVolume(item.source, item.destination)) { skipped.push({ fileName: item.fileName, reason: "cross-volume move refused" }); continue; }
    try {
      await move(item.source, item.destination);
      moved++;
    } catch (error) {
      failed.push({ fileName: item.fileName, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { moved, skipped, failed, durationMs: Date.now() - started };
}
