import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { bridge, errorMessage } from "@/lib/bridge";
import type { HostSettings } from "@/types";

/** 热键录制:聚焦后直接按下组合键(如 Ctrl+Shift+M),Esc 清空。 */
function HotkeyInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Input
      readOnly
      value={value}
      placeholder="点击后按下组合键"
      className="w-44 cursor-pointer text-right font-mono"
      onKeyDown={(e) => {
        e.preventDefault();
        if (e.key === "Escape") { onChange(""); return; }
        if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // 只按了修饰键,等待组合
        const parts: string[] = [];
        if (e.ctrlKey) parts.push("Ctrl");
        if (e.altKey) parts.push("Alt");
        if (e.shiftKey) parts.push("Shift");
        if (e.metaKey) parts.push("Super");
        parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key);
        onChange(parts.join("+"));
      }}
    />
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<HostSettings | null>(null);
  const [hotkey, setHotkey] = useState("");
  const [days, setDays] = useState("");
  const [bytes, setBytes] = useState("");
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    bridge.getSettings()
      .then((s) => {
        setSettings(s);
        setHotkey(s.launcherHotkey);
        setDays(String(s.logRetentionDays));
        setBytes(String(s.maxLogBytesPerApp));
      })
      .catch((e) => toast(errorMessage(e), true));
  }, [toast]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const fresh = await bridge.patchSettings({
        launcherHotkey: hotkey,
        logRetentionDays: Number(days),
        maxLogBytesPerApp: Number(bytes),
      });
      setSettings(fresh);
      setHotkey(fresh.launcherHotkey);
      setDays(String(fresh.logRetentionDays));
      setBytes(String(fresh.maxLogBytesPerApp));
      toast("设置已保存,热键与日志配置即时生效");
    } catch (e) {
      toast(errorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Host 设置</h1>
          <p className="mt-1 text-muted-foreground">设置仅影响宿主,不会修改 App 清单。</p>
        </div>

        <Card title="常规">
          {settings ? (
            <div className="divide-y divide-border/60">
              <div className="flex items-center justify-between gap-6 py-3 first:pt-0">
                <div>
                  <div className="text-[13px] font-medium">Launcher 热键</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">点击右侧输入框后直接按下组合键,Esc 清空</div>
                </div>
                <HotkeyInput value={hotkey} onChange={setHotkey} />
              </div>
              <div className="flex items-center justify-between gap-6 py-3">
                <div>
                  <div className="text-[13px] font-medium">日志保留天数</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">超期的 App 日志文件会被清理,单位:天(1~365)</div>
                </div>
                <div className="flex items-center gap-2">
                  <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-24 text-right font-mono" />
                  <span className="text-muted-foreground">天</span>
                </div>
              </div>
              <div className="flex items-center justify-between gap-6 py-3 last:pb-0">
                <div>
                  <div className="text-[13px] font-medium">每个 App 最大日志容量</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">单 App 日志超过该值触发轮转,单位:字节({Math.round(Number(bytes || 0) / 1024 / 1024 * 10) / 10} MB)</div>
                </div>
                <div className="flex items-center gap-2">
                  <Input type="number" min={1024} value={bytes} onChange={(e) => setBytes(e.target.value)} className="w-28 text-right font-mono" />
                  <span className="text-muted-foreground">字节</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground">正在加载设置…</div>
          )}
        </Card>

        <div className="flex justify-end">
          <Button onClick={() => void save()} disabled={saving || !settings}>
            {saving ? "正在保存…" : "保存设置"}
          </Button>
        </div>
      </div>
    </main>
  );
}
