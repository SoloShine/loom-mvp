import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Command, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { bridge } from "@/launcher/bridge";
import { score } from "@/lib/fuzzy";
import { statusText } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { LauncherAppInfo } from "@/types";

interface LauncherItem {
  appId: string;
  appName: string;
  kind: "app" | "command";
  id: string;
  title: string;
  status: string;
  favorite?: boolean;
  lastUsedAt?: string;
}

const MAX_ITEMS = 30;

// 与原生页 refresh() 一致:App 与其命令都是面板项,命令继承 App 的收藏/最近使用。
function buildItems(apps: LauncherAppInfo[]): LauncherItem[] {
  const items: LauncherItem[] = [];
  for (const a of apps) {
    items.push({ appId: a.id, appName: a.name, kind: "app", id: a.id, title: a.name, status: a.status, favorite: a.favorite, lastUsedAt: a.lastUsedAt });
    for (const c of a.commands) {
      items.push({ appId: a.id, appName: a.name, kind: "command", id: c.id, title: c.title, status: a.status, favorite: a.favorite, lastUsedAt: a.lastUsedAt });
    }
  }
  return items;
}

function byLastUsedDesc(a: LauncherItem, b: LauncherItem): number {
  return Date.parse(b.lastUsedAt ?? "1970-01-01") - Date.parse(a.lastUsedAt ?? "1970-01-01") || a.appName.localeCompare(b.appName);
}

function itemKey(it: LauncherItem): string {
  return `${it.kind}:${it.appId}:${it.id}`;
}

export function LauncherApp() {
  const [items, setItems] = useState<LauncherItem[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(buildItems(await bridge.getApps()));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const offError = bridge.onError((message) => setError(message));
    const offRefresh = bridge.onRefresh(() => { void refresh(); });
    return () => {
      offError();
      offRefresh();
    };
  }, [refresh]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    inputRef.current?.focus();
    // 浮层每次获得焦点(打开/切回)都把焦点交还输入框,否则方向键无效
    const onFocus = () => inputRef.current?.focus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const q = query.trim();
  const flat = useMemo(() => {
    if (!q) return null;
    return items
      .map((it) => ({ it, s: score(`${it.appName} ${it.title}`, q) }))
      .filter(({ s }) => s > 0)
      .sort((a, b) => b.s - a.s || Number(!!b.it.favorite) - Number(!!a.it.favorite) || Date.parse(b.it.lastUsedAt ?? "1970-01-01") - Date.parse(a.it.lastUsedAt ?? "1970-01-01"))
      .map(({ it }) => it)
      .slice(0, MAX_ITEMS);
  }, [items, q]);

  const groups = useMemo(() => {
    if (q) return null;
    return [
      { label: "收藏", items: items.filter((it) => it.favorite).sort(byLastUsedDesc) },
      { label: "最近使用", items: items.filter((it) => !it.favorite && it.lastUsedAt).sort(byLastUsedDesc) },
      { label: "其他", items: items.filter((it) => !it.favorite && !it.lastUsedAt).sort((a, b) => a.appName.localeCompare(b.appName)) },
    ].filter((g) => g.items.length > 0);
  }, [items, q]);

  const visible = useMemo(() => {
    const merged = flat ?? (groups ?? []).flatMap((g) => g.items);
    return merged.slice(0, MAX_ITEMS);
  }, [flat, groups]);

  useEffect(() => { setActive(0); }, [q, items]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const run = useCallback(async (index: number) => {
    const it = visible[index];
    if (!it) return;
    try {
      const ok = it.kind === "app"
        ? await bridge.startApp(it.appId)
        : await bridge.invokeCommand(it.appId, it.id);
      if (ok) bridge.hide();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [visible]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (visible.length ? Math.min(a + 1, visible.length - 1) : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      void run(active);
    } else if (e.key === "Escape") {
      bridge.hide();
    }
  };

  const indexOf = new Map(visible.map((it, i) => [it, i]));
  const sections = flat ? [{ label: null as string | null, items: flat }] : (groups ?? []);

  return (
    <div className="flex h-screen flex-col overflow-hidden border border-border bg-card">
      <Input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="搜索 App / 命令…"
        autoFocus
        spellCheck={false}
        className="h-12 rounded-none border-0 border-b bg-transparent px-3.5 text-[15px] shadow-none focus-visible:border-border focus-visible:ring-0"
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error && (
          <div role="alert" className="mb-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive">
            {error}
          </div>
        )}
        {sections.map((section) => (
          <div key={section.label ?? "__flat"} className="mb-1 last:mb-0">
            {section.label && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{section.label}</div>}
            {section.items.map((it) => {
              const i = indexOf.get(it) ?? -1;
              return (
                <button
                  key={itemKey(it)}
                  type="button"
                  ref={i === active ? activeRef : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void run(i)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-[13px]",
                    i === active ? "bg-accent" : "hover:bg-accent/50",
                  )}
                >
                  {it.kind === "app"
                    ? <Play className="size-4 shrink-0 text-muted-foreground" />
                    : <Command className="size-4 shrink-0 text-muted-foreground" />}
                  <span className="shrink-0">{it.kind === "app" ? it.appName : `${it.appName} › ${it.title}`}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
                    {it.kind === "app" ? statusText(it.status) : it.status === "running" ? "命令" : "命令 · 将自动启动"}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
        {!visible.length && (
          <div className="px-3 py-6 text-center text-muted-foreground">{q ? "无匹配结果" : "暂无可用 App"}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between border-t border-border px-3.5 py-1.5">
        <span className="text-[11px] text-muted-foreground">↑↓ 选择 · Enter 执行 · Esc 关闭</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-[11px] text-muted-foreground"
          onClick={() => { bridge.openManagement(); bridge.hide(); }}
        >
          管理中心
        </Button>
      </div>
    </div>
  );
}
