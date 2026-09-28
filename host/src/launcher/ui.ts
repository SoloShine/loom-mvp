interface LauncherBridge {
  getApps(): Promise<
    {
      id: string;
      name: string;
      status: string;
      enabled: boolean;
      error?: string;
      commands: { id: string; title: string }[];
      favorite?: boolean;
      lastUsedAt?: string;
    }[]
  >;
  startApp(id: string): Promise<boolean>;
  invokeCommand(id: string, command: string): Promise<boolean>;
  hide(): void;
  onRefresh(cb: () => void): void;
  onError(cb: (message: string) => void): void;
  openManagement(): void;
}

const bridge = (window as any).__launcher as LauncherBridge;

interface Item {
  appId: string;
  appName: string;
  kind: "app" | "command";
  id: string;
  title: string;
  status: string;
  broken?: boolean;
  enabled: boolean;
  favorite?: boolean;
  lastUsedAt?: string;
  error?: string;
}

let items: Item[] = [];
let filtered: Item[] = [];
let active = 0;

function score(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx; // substring beats subsequence
  let ti = 0;
  let s = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    streak = found === ti ? streak + 1 : 0;
    s += 1 + streak;
    ti = found + 1;
  }
  return s;
}

function refilter(): void {
  const q = (document.getElementById("q") as HTMLInputElement).value.trim();
  filtered = items
    .map((it) => ({ it, s: score(`${it.appName} ${it.title}`, q) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s || Number(!!b.it.favorite) - Number(!!a.it.favorite) || Date.parse(b.it.lastUsedAt ?? "1970-01-01") - Date.parse(a.it.lastUsedAt ?? "1970-01-01"))
    .map(({ it }) => it);
  active = 0;
  render();
}

function render(): void {
  const list = document.getElementById("list")!;
  list.innerHTML = "";
  filtered.slice(0, 30).forEach((it, i) => {
    const li = document.createElement("li");
    if (i === active) li.className = "active";
    if (it.broken || !it.enabled) li.className += " unavailable";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = it.kind === "app" ? it.appName : `${it.appName} › ${it.title}`;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = it.broken ? `清单损坏 · ${it.error ?? "请在管理中心修复清单"}` : !it.enabled ? "已禁用 · 管理中心启用" : it.kind === "app" ? `启动 (${it.status})` : it.status === "running" ? "命令" : "命令 · 将自动启动";
    li.append(title, meta);
    li.onclick = () => run(i);
    list.appendChild(li);
    if (i === active) li.scrollIntoView({ block: "nearest" });
  });
  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.textContent = "无匹配结果";
    list.appendChild(li);
  }
}

async function run(i: number): Promise<void> {
  const it = filtered[i];
  if (!it) return;
  if (it.broken || !it.enabled) { showError(it.broken ? `BROKEN_MANIFEST: ${it.error ?? it.appId}` : `APP_DISABLED: ${it.appId} 已禁用，请在管理中心启用`); return; }
  try {
    const ok = it.kind === "app" ? await bridge.startApp(it.appId) : await bridge.invokeCommand(it.appId, it.id);
    if (ok) bridge.hide();
  } catch (e) { showError((e as Error).message); }
}

function showError(message: string): void {
  const list = document.getElementById("list")!;
  let notice = document.getElementById("launcher-error");
  if (!notice) { notice = document.createElement("li"); notice.id = "launcher-error"; list.prepend(notice); }
  notice.textContent = message;
  notice.setAttribute("role", "alert");
}

async function refresh(): Promise<void> {
  const apps = await bridge.getApps();
  items = [];
  for (const a of apps) {
    const broken = a.status === "broken";
    items.push({
      appId: a.id,
      appName: broken ? `${a.name} (${a.id})` : a.name,
      kind: "app",
      id: a.id,
      title: a.name,
      status: a.status,
      broken,
      enabled: a.enabled,
      favorite: a.favorite,
      lastUsedAt: a.lastUsedAt,
      error: a.error,
    });
    for (const c of a.commands ?? []) {
      items.push({ appId: a.id, appName: a.name, kind: "command", id: c.id, title: c.title, status: a.status, enabled: a.enabled, favorite: a.favorite, lastUsedAt: a.lastUsedAt });
    }
  }
  refilter();
}

const input = document.getElementById("q") as HTMLInputElement;
(document.getElementById("manage") as HTMLButtonElement).onclick = () => { bridge.openManagement(); bridge.hide(); };
input.addEventListener("input", refilter);
input.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    active = Math.min(active + 1, Math.min(filtered.length, 30) - 1);
    render();
    e.preventDefault();
  } else if (e.key === "ArrowUp") {
    active = Math.max(active - 1, 0);
    render();
    e.preventDefault();
  } else if (e.key === "Enter") {
    void run(active);
  } else if (e.key === "Escape") {
    bridge.hide();
  }
});

bridge.onError(showError);
bridge.onRefresh(() => { void refresh().catch((e) => showError((e as Error).message)); });
void refresh().catch((e) => showError((e as Error).message));
input.focus();
// 浮层每次获得焦点(打开/切回)都把焦点交还输入框,否则方向键无效
window.addEventListener("focus", () => input.focus());
