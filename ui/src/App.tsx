import { useEffect, useState } from "react";
import {
  Blocks, LayoutGrid, Settings as SettingsIcon, Search, Sun, Moon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/card";
import { AppsPage } from "@/pages/apps";
import { SettingsPage } from "@/pages/settings";
import { demoMode } from "@/lib/bridge";
import { resolveTheme, saveTheme, watchSystemTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type View = "apps" | "settings";

export function App() {
  const [view, setView] = useState<View>("apps");
  const [query, setQuery] = useState("");
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  useEffect(() => watchSystemTheme(setTheme), []);

  const toggleTheme = () => {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    saveTheme(next);
  };

  return (
    <div className="flex h-screen overflow-hidden text-[13px]">
      {/* 侧栏 */}
      <aside className="flex w-52 shrink-0 flex-col border-r border-border/70 bg-card/40">
        <div className="flex h-14 items-center gap-2.5 border-b border-border/70 px-4">
          <div className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground shadow-sm">
            <Blocks className="size-4" />
          </div>
          <div>
            <div className="text-sm font-semibold leading-none">Loom</div>
            <div className="mt-0.5 text-[11px] leading-none text-muted-foreground">Mini App Host</div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-2">
          {([
            { key: "apps", icon: LayoutGrid, label: "应用" },
            { key: "settings", icon: SettingsIcon, label: "设置" },
          ] as const).map(({ key, icon: Icon, label }) => (
            <button
              key={key}
              onClick={() => setView(key)}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors",
                view === key
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              <Icon className="size-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-border/70 px-4 py-3 text-[11px] text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Host 已连接
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border/70 px-5">
          {view === "apps" && (
            <div className="relative w-72">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索 App…"
                className="h-8 pl-8 pr-12"
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
                <Kbd>Ctrl K</Kbd>
              </div>
            </div>
          )}
          {demoMode && <Badge variant="outline">示例数据 · 未接入 Host</Badge>}
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={toggleTheme} aria-label="切换主题">
              {theme === "dark" ? <Sun /> : <Moon />}
            </Button>
          </div>
        </header>

        {view === "apps" ? <AppsPage query={query} /> : <SettingsPage />}
      </div>
    </div>
  );
}
