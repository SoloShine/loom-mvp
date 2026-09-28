import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, Row } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { bridge, errorMessage } from "@/lib/bridge";
import type { HostSettings } from "@/types";

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
                  <div className="mt-0.5 text-xs text-muted-foreground">打开命令面板的全局快捷键</div>
                </div>
                <Input value={hotkey} onChange={(e) => setHotkey(e.target.value)} className="w-44 text-right font-mono" />
              </div>
              <div className="flex items-center justify-between gap-6 py-3">
                <div>
                  <div className="text-[13px] font-medium">日志保留天数</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">超期的 App 日志文件会被清理(1~365)</div>
                </div>
                <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-28 text-right font-mono" />
              </div>
              <div className="flex items-center justify-between gap-6 py-3 last:pb-0">
                <div>
                  <div className="text-[13px] font-medium">每个 App 最大日志容量</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">单 App 日志超过该字节数触发轮转(≥1024)</div>
                </div>
                <Input type="number" min={1024} value={bytes} onChange={(e) => setBytes(e.target.value)} className="w-36 text-right font-mono" />
              </div>
            </div>
          ) : (
            <div className="text-muted-foreground">正在加载设置…</div>
          )}
        </Card>

        <Card title="当前生效值">
          {settings ? (
            <>
              <Row label="热键">{settings.launcherHotkey}</Row>
              <Row label="保留">{settings.logRetentionDays} 天</Row>
              <Row label="容量">{settings.maxLogBytesPerApp} 字节</Row>
            </>
          ) : (
            <div className="text-muted-foreground">—</div>
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
