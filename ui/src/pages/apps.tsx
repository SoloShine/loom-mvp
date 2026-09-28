import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Play, Square, RotateCw, Folder, Command, Star, X, History, ScrollText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, Kbd, Row, StatusDot } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { bridge, demoMode, errorMessage } from "@/lib/bridge";
import { statusText } from "@/lib/status";
import { cn } from "@/lib/utils";
import type { AppInfo } from "@/types";

export function AppsPage({ query }: { query: string }) {
  const [apps, setApps] = useState<AppInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AppInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [sub, setSub] = useState<{ kind: "history" | "logs"; lines: string[] } | null>(null);
  const toast = useToast();

  const loadList = useCallback(
    async (prefer?: string | null) => {
      try {
        const list = await bridge.getApps();
        setLoadError(null);
        setApps(list);
        setSelectedId((current) => {
          const wanted = prefer ?? current;
          if (wanted && list.some((a) => a.id === wanted)) return wanted;
          return list[0]?.id ?? null;
        });
      } catch (e) {
        setLoadError(errorMessage(e));
      }
    },
    [],
  );

  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let alive = true;
    bridge.getApp(selectedId)
      .then((app) => { if (alive) { setDetail(app); setSub(null); } })
      .catch((e) => { if (alive) toast(errorMessage(e), true); });
    return () => { alive = false; };
  }, [selectedId, toast]);

  const visible = useMemo(() => {
    const list = apps ?? [];
    const q = query.trim().toLowerCase();
    return q ? list.filter((a) => `${a.name} ${a.id}`.toLowerCase().includes(q)) : list;
  }, [apps, query]);

  const doAction = useCallback(
    async (action: string) => {
      if (!detail || busy) return;
      setBusy(true);
      try {
        const fresh = await bridge.action(detail.id, action);
        setDetail(fresh);
        toast("操作已完成");
        await loadList(fresh.id);
      } catch (e) {
        toast(errorMessage(e), true);
      } finally {
        setBusy(false);
      }
    },
    [detail, busy, toast, loadList],
  );

  const showSub = useCallback(
    async (kind: "history" | "logs") => {
      if (!detail) return;
      try {
        if (kind === "history") {
          const data = await bridge.getHistory(detail.id, { limit: 30 });
          setSub({
            kind,
            lines: (data.events ?? []).map((e) =>
              [e.at, e.kind, e.outcome, e.command, e.message].filter(Boolean).join(" ")),
          });
        } else {
          const data = await bridge.getLogs(detail.id, { limit: 100 });
          setSub({ kind, lines: data.lines ?? [] });
        }
      } catch (e) {
        toast(errorMessage(e), true);
      }
    },
    [detail, toast],
  );

  if (loadError) {
    return <div className="p-6"><div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive">加载失败:{loadError}</div></div>;
  }
  if (!apps) {
    return <div className="p-6 text-muted-foreground">正在加载…</div>;
  }

  return (
    <div className="flex min-h-0 flex-1">
      {/* App 列表 */}
      <div className="w-72 shrink-0 space-y-0.5 overflow-y-auto border-r border-border/70 p-2.5">
        {visible.map((a) => (
          <button
            key={a.id}
            onClick={() => setSelectedId(a.id)}
            className={cn(
              "flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-left transition-colors",
              a.id === selectedId ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <span className="flex w-full items-center gap-2">
              <StatusDot status={a.status} />
              <span className="truncate font-medium">{a.name}</span>
              {a.favorite && <Star className="ml-auto size-3.5 fill-amber-400 text-amber-400" />}
            </span>
            <span className="pl-4 text-[11px] text-muted-foreground">
              {a.id} · {statusText(a.status)}
              {!a.enabled && " · 已禁用"}
            </span>
          </button>
        ))}
        {!visible.length && <div className="p-4 text-muted-foreground">暂无匹配 App</div>}
      </div>

      {/* 详情 */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        {detail ? (
          <div className="mx-auto max-w-3xl space-y-4 p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-semibold tracking-tight">{detail.name}</h1>
                  <Badge variant={detail.status === "running" ? "default" : detail.status === "broken" || detail.status === "crashed" ? "destructive" : "secondary"}>
                    {statusText(detail.status)}
                  </Badge>
                  {!detail.enabled && <Badge variant="outline">已禁用</Badge>}
                </div>
                <p className="mt-1 truncate text-muted-foreground">
                  {detail.id} · v{detail.version} · {detail.uiType ?? "none"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {detail.status === "running" || detail.status === "starting" ? (
                  <Button size="sm" disabled={busy} onClick={() => void doAction("stop")}><Square />停止</Button>
                ) : (
                  <Button size="sm" disabled={busy || detail.status === "broken" || !detail.enabled} onClick={() => void doAction("start")}><Play />启动</Button>
                )}
                <Button variant="outline" size="sm" disabled={busy || detail.status === "broken" || !detail.enabled} onClick={() => void doAction("reload")}><RotateCw />重载</Button>
                <Button variant="ghostDestructive" size="sm" disabled={busy || detail.status === "broken"} onClick={() => void doAction(detail.enabled ? "disable" : "enable")}>
                  {detail.enabled ? "禁用" : "启用"}
                </Button>
                <Button variant="ghost" size="icon" disabled={busy || detail.status === "broken"} aria-label="收藏" onClick={() => void doAction(detail.favorite ? "unfavorite" : "favorite")}>
                  <Star className={cn(detail.favorite && "fill-amber-400 text-amber-400")} />
                </Button>
              </div>
            </div>

            {detail.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
                清单错误:{detail.error}
              </div>
            )}
            {detail.manifestIssues?.length ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive">
                构建问题:{detail.manifestIssues.join(";")}
              </div>
            ) : null}

            <Card title="基本信息">
              <Row label="目录">
                <span className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
                  <Folder className="size-3.5" />
                  {detail.path}
                </span>
              </Row>
              <Row label="UI 类型"><Badge variant="secondary">{detail.uiType ?? "none"}</Badge></Row>
              <Row label="使用次数">{detail.useCount ?? 0} 次</Row>
              <Row label="最近使用">{detail.lastUsedAt ?? "暂无"}</Row>
            </Card>

            <Card title="权限声明">
              <div className="flex flex-wrap gap-1.5">
                {detail.permissions.length
                  ? detail.permissions.map((p) => <Badge key={p} variant="outline" className="font-mono">{p}</Badge>)
                  : <span className="text-muted-foreground">未声明</span>}
              </div>
              <p className="mt-2.5 text-xs leading-5 text-muted-foreground">
                这是本地 App 的能力声明,当前版本不强制拦截 host.*,只运行可信代码。
              </p>
            </Card>

            <Card title="命令与热键">
              <div className="space-y-1">
                {detail.commands.map((c) => {
                  const hotkey = detail.hotkeys?.find((h) => h.command === c.id);
                  return (
                    <div key={c.id} className="flex items-center justify-between py-1 text-[13px]">
                      <span className="inline-flex items-center gap-1.5">
                        <Command className="size-3.5 text-muted-foreground" />
                        {c.title}
                        <span className="font-mono text-xs text-muted-foreground">{c.id}</span>
                      </span>
                      {hotkey && <Kbd>{hotkey.combo}</Kbd>}
                    </div>
                  );
                })}
                {!detail.commands.length && <div className="text-muted-foreground">暂无命令</div>}
              </div>
            </Card>

            <Card
              title="运行记录与日志"
              action={
                <span className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void showSub("history")}><History />历史</Button>
                  <Button variant="ghost" size="sm" onClick={() => void showSub("logs")}><ScrollText />日志</Button>
                </span>
              }
            >
              {sub ? (
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">{sub.kind === "history" ? "最近 30 条运行记录" : "最近 100 行日志"}</span>
                    <Button variant="ghost" size="sm" onClick={() => setSub(null)}><X />关闭</Button>
                  </div>
                  <pre className="max-h-96 overflow-auto rounded-lg border border-border/60 bg-muted/40 p-3 text-left font-mono text-[11px] leading-5 text-muted-foreground">
                    {sub.lines.length ? sub.lines.join("\n") : "暂无内容"}
                  </pre>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">查看该 App 的运行记录({demoMode ? "演示数据" : "来自 history.jsonl"})或实时日志。</p>
              )}
            </Card>
          </div>
        ) : (
          <div className="p-6 text-muted-foreground">选择一个 App 查看详情</div>
        )}
      </main>
    </div>
  );
}
