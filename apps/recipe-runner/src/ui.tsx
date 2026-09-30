// recipe-runner 主界面（阶段 3，React 单向投影）：左列配方列表 × 右侧详情
// （头部 / 动作按钮 / 参数表单 / 步骤清单×轨迹叠加 / 历史切换）。
//
// 边界约定（对齐 mini-host/frontend/component-guidelines 的通用原则）：
// - 消息边界在本文件：host.app.onMessage 收 res / state / form，子组件只收
//   props；纯逻辑全部在 ui-logic.ts（tests 单测），React 组件本身不测。
// - 单向投影（design UI 取舍表）：只读展示 + 动作按钮，不做结构编辑。
// - 样式走 <style> 注入 + 语义 token（react 模板约束：不 import .css——
//   esbuild 会拆出壳不加载的 ui.css；App 窗口壳无 CSP meta，内联可用）。
//
// 协议（与 src/main.ts 对齐）：
//   UI → main: {type:"req", reqId, action, args} / {type:"form-result"|"form-cancel", formId}
//                / {type:"ready"}
//   main → UI: {type:"res", reqId, ok, data|error} / {type:"state"}（主动推送刷新）
//                / {type:"form", formId, kind, ...} / {type:"form-dismiss", formId}（阶段 2 网关）

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { host } from "@mini/sdk";
import type { UiField } from "./actions/ui";
import type { TraceStep } from "./engine/types";
import { SchemaForm } from "./ui/schema-form";
import {
  finalizeFormValues, formatMs, formatOutValue, formatTime, groupTraceSteps, pendingSteps,
  savePreset as savePresetOp, seedFormValues, topLevelSteps, validateFields,
  type FormValues, type RecipeDetail, type RecipeSummary, type TraceRow,
} from "./ui-logic";

// ---------------------------------------------------------------------------
// 请求基建：req/res 配对（main 回 {type:"res", reqId, ok, ...}）
// ---------------------------------------------------------------------------

interface PendingReq {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

const pendingReqs = new Map<number, PendingReq>();
let reqSeq = 0;

function callMain<T>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const reqId = ++reqSeq;
  return new Promise<T>((resolve, reject) => {
    pendingReqs.set(reqId, { resolve: resolve as (v: unknown) => void, reject });
    host.app.send({ type: "req", reqId, action, args });
  });
}

function settleReq(m: Record<string, unknown>): void {
  const reqId = m.reqId;
  if (typeof reqId !== "number") return;
  const p = pendingReqs.get(reqId);
  if (!p) return;
  pendingReqs.delete(reqId);
  if (m.ok === true) p.resolve(m.data);
  else p.reject(new Error(typeof m.error === "string" ? m.error : "请求失败"));
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------------------
// 表单网关消息（阶段 2 协议，字段不变）：ask / confirm / menu
// ---------------------------------------------------------------------------

interface GatewayForm {
  formId: number;
  kind: "ask" | "confirm" | "menu";
  title?: string;
  body?: string;
  fields?: UiField[];
  items?: { value: string; label?: string }[];
}

function GatewayFormCard(props: {
  form: GatewayForm;
  onFinish: (value: unknown) => void;
  onCancel: () => void;
}): ReactElement {
  const { form, onFinish, onCancel } = props;
  const [values, setValues] = useState<FormValues>(() => seedFormValues(form.fields ?? []));
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const submitAsk = (): void => {
    const missing = validateFields(form.fields ?? [], values);
    if (missing.length > 0) {
      setErr(`必填字段缺失: ${missing.join(", ")}`);
      return;
    }
    onFinish(finalizeFormValues(form.fields ?? [], values));
  };

  return (
    <div className="overlay" tabIndex={-1} ref={(n) => { n?.focus(); }}>
      <div className="card">
        <h2>{form.title ?? ""}</h2>
        {form.body !== undefined && form.body !== "" && <p className="card-body">{form.body}</p>}
        {form.kind === "ask" && (
          <SchemaForm
            fields={form.fields ?? []}
            values={values}
            onChange={(name, v) => setValues((prev) => ({ ...prev, [name]: v }))}
          />
        )}
        {form.kind === "menu" && (
          <div className="menu-list">
            {(form.items ?? []).map((it) => (
              <button key={it.value} type="button" className="menu-item" onClick={() => onFinish(it.value)}>
                {it.label ?? it.value}
              </button>
            ))}
          </div>
        )}
        {err && <div className="form-error">{err}</div>}
        <div className="actions">
          {form.kind !== "menu" && (
            <button type="button" className="primary" onClick={form.kind === "ask" ? submitAsk : () => onFinish(true)}>
              确定
            </button>
          )}
          <button type="button" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 子组件（只收 props）
// ---------------------------------------------------------------------------

function StatusDot(props: { status: string }): ReactElement {
  return <span className={`dot st-${props.status}`} title={props.status} />;
}

function RecipeList(props: {
  list: RecipeSummary[];
  selected: string | null;
  onSelect: (id: string) => void;
}): ReactElement {
  return (
    <aside className="left">
      {props.list.map((r) => {
        const state = !r.ok ? "error" : r.running ? "running" : r.hotkeyState === "hotkey-conflict" ? "conflict" : "ok";
        return (
          <button
            key={r.id}
            type="button"
            className={`recipe-item${props.selected === r.id ? " active" : ""}`}
            onClick={() => props.onSelect(r.id)}
            title={!r.ok ? r.errors.join("; ") : r.id}
          >
            <span className={`dot list-${state}`} />
            <span className="recipe-name">{r.name}</span>
            {r.hotkey && <span className="recipe-hotkey">{r.hotkey}</span>}
          </button>
        );
      })}
      {props.list.length === 0 && <div className="empty">recipes/ 内没有配方</div>}
    </aside>
  );
}

function StepLine(props: { step: TraceStep; expanded: boolean; onToggle: () => void }): ReactElement {
  const { step, expanded } = props;
  const hasDetail = step.status === "error" || step.out !== undefined || step.note !== undefined
    || Object.keys(step.args ?? {}).length > 0;
  return (
    <div className={`trace-row${expanded ? " open" : ""}`}>
      <div className="trace-line" onClick={hasDetail ? props.onToggle : undefined}>
        <StatusDot status={step.status} />
        {step.iter !== undefined && <span className="trace-iter">#{step.iter}</span>}
        <span className="trace-id">{step.id}</span>
        <span className="trace-action">{step.action}</span>
        <span className="trace-ms">{formatMs(step.ms)}</span>
        {hasDetail && <span className="caret">{expanded ? "▾" : "▸"}</span>}
      </div>
      {expanded && (
        <div className="trace-detail">
          <div className="kv"><span className="k">args</span><pre>{JSON.stringify(step.args ?? {}, null, 2)}</pre></div>
          {step.note !== undefined && <div className="kv"><span className="k">note</span><pre>{step.note}</pre></div>}
          {step.error !== undefined && <div className="kv"><span className="k">error</span><pre className="err">{step.error}</pre></div>}
          {step.out !== undefined && (
            <div className="kv"><span className="k">out</span><pre>{formatOutValue(step.out)}</pre></div>
          )}
        </div>
      )}
    </div>
  );
}

function TraceRowView(props: {
  row: TraceRow;
  rowKey: string;
  expandedKeys: Set<string>;
  collapsed: boolean;
  onToggleExpand: (key: string) => void;
  onToggleCollapse: () => void;
}): ReactElement {
  const { row, rowKey, expandedKeys, collapsed, onToggleExpand } = props;
  if (row.kind === "container") {
    const s = row.step;
    return (
      <div className="trace-group">
        <div className="trace-line container-line" onClick={props.onToggleCollapse}>
          <StatusDot status={s.status} />
          <span className="trace-id">{s.id}</span>
          <span className="trace-action">{s.action}</span>
          <span className="trace-ms">{formatMs(s.ms)}</span>
          <span className="trace-iter-count">{row.children.length} 子步</span>
          <span className="caret">{collapsed ? "▸" : "▾"}</span>
        </div>
        {!collapsed && (
          <div className="trace-children">
            {row.children.map((c, i) => {
              const key = `${rowKey}/${i}`;
              return <StepLine key={key} step={c} expanded={expandedKeys.has(key)} onToggle={() => onToggleExpand(key)} />;
            })}
          </div>
        )}
      </div>
    );
  }
  return <StepLine step={row.step} expanded={expandedKeys.has(rowKey)} onToggle={() => onToggleExpand(rowKey)} />;
}

function StepPicker(props: {
  detail: RecipeDetail;
  onPick: (stepId: string) => void;
  onClose: () => void;
}): ReactElement {
  const steps = topLevelSteps(props.detail.declaredSteps);
  return (
    <div className="overlay" tabIndex={-1} ref={(n) => { n?.focus(); }}>
      <div className="card">
        <h2>从第 N 步重跑 — {props.detail.name}</h2>
        <p className="card-body">前序步骤以上次 run 各步的 out 重放（标记 replayed）；仅顶层步骤可作入口。</p>
        <div className="menu-list">
          {steps.map((s, i) => (
            <button key={s.id} type="button" className="menu-item" onClick={() => props.onPick(s.id)}>
              {i + 1}. {s.id} <span className="trace-action">{s.action}</span>
            </button>
          ))}
        </div>
        <div className="actions">
          <button type="button" onClick={props.onClose}>取消</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// App：状态 + 消息边界 + 布局
// ---------------------------------------------------------------------------

function App(): ReactElement {
  const [list, setList] = useState<RecipeSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecipeDetail | null>(null);
  const [formValues, setFormValues] = useState<FormValues>({});
  const [showParams, setShowParams] = useState(true);
  const [gateway, setGateway] = useState<GatewayForm | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  const [presetName, setPresetName] = useState("");
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState<{ text: string; kind: "info" | "error" } | null>(null);

  const selectedRef = useRef<string | null>(null);
  const runIndexRef = useRef(0);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((text: string, kind: "info" | "error" = "info") => {
    setBanner({ text, kind });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setBanner(null), 4000);
  }, []);

  const loadDetail = useCallback(async (id: string, runIndex: number, reseed: boolean) => {
    try {
      const d = await callMain<RecipeDetail>("detail", { recipe: id, runIndex });
      setDetail(d);
      if (reseed) setFormValues(seedFormValues(d.paramFields));
    } catch (e) {
      setDetail(null);
      flash(msg(e), "error");
    }
  }, [flash]);

  const refresh = useCallback(async () => {
    try {
      const next = await callMain<RecipeSummary[]>("list", {});
      setList(next);
      const sel = selectedRef.current;
      if (sel && next.some((r) => r.id === sel)) {
        // 状态推送刷新：不 reseed 表单（不打断用户正在编辑的参数）
        await loadDetail(sel, runIndexRef.current, false);
      } else {
        // 选中项消失（改名/删除/首拉）：回落到第一个
        const first = next[0]?.id ?? null;
        selectedRef.current = first;
        setSelected(first);
        if (first) await loadDetail(first, 0, true);
        else setDetail(null);
      }
    } catch (e) {
      flash(msg(e), "error");
    } finally {
      setLoading(false);
    }
  }, [flash, loadDetail]);

  const select = useCallback((id: string) => {
    selectedRef.current = id;
    runIndexRef.current = 0;
    setSelected(id);
    setExpandedKeys(new Set());
    setCollapsedKeys(new Set());
    void loadDetail(id, 0, true);
  }, [loadDetail]);

  const selectRun = useCallback((index: number) => {
    const id = selectedRef.current;
    if (!id) return;
    runIndexRef.current = index;
    void loadDetail(id, index, false);
  }, [loadDetail]);

  useEffect(() => {
    host.app.onMessage((m: unknown) => {
      if (!m || typeof m !== "object") return;
      const t = m as Record<string, unknown>;
      if (t.type === "res") settleReq(t);
      else if (t.type === "state") void refresh();
      else if (t.type === "form" && typeof t.formId === "number") setGateway(t as unknown as GatewayForm);
      else if (t.type === "form-dismiss" && typeof t.formId === "number") {
        setGateway((g) => (g && g.formId === t.formId ? null : g));
      }
    });
  }, [refresh]);

  // 启动：本地主动拉一次 + 上报 ready（main 据此推送 state；不依赖推送时序）
  useEffect(() => {
    void refresh();
    host.app.send({ type: "ready" });
  }, [refresh]);

  // ---- 动作（写经 main；表单值定型 + required 校验在发送前）----

  const currentParams = (): Record<string, unknown> | null => {
    if (!detail || detail.paramFields.length === 0) return {};
    const missing = validateFields(detail.paramFields, formValues);
    if (missing.length > 0) {
      flash(`必填字段缺失: ${missing.join(", ")}`, "error");
      return null;
    }
    return finalizeFormValues(detail.paramFields, formValues);
  };

  const startRun = async (kind: "run" | "dryRun" | "rerun", extra: Record<string, unknown> = {}): Promise<void> => {
    if (!detail) return;
    const params = currentParams();
    if (params === null) return;
    try {
      const r = await callMain<{ runId: string }>(kind, { recipe: detail.id, params, ...extra });
      flash(`已受理 run ${r.runId}${kind === "dryRun" ? "（dry-run）" : ""}`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  const stopRun = async (): Promise<void> => {
    if (!detail) return;
    try {
      const r = await callMain<{ stopped: number }>("stop", { recipe: detail.id });
      flash(`已请求停止 ${r.stopped} 个 run`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  const copyPath = async (): Promise<void> => {
    if (!detail) return;
    try {
      await callMain("copyPath", { recipe: detail.id });
      flash(`已复制 ${detail.yamlPath}`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  const savePreset = async (): Promise<void> => {
    if (!detail) return;
    const params = currentParams();
    if (params === null) return;
    try {
      // 名字校验复用 ui-logic（main 写入走同一实现），空名先在本地拦下
      savePresetOp({}, presetName, params);
      await callMain("savePreset", { recipe: detail.id, name: presetName, values: params });
      setPresetName("");
      flash(`preset 已保存: ${presetName.trim()}`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  const applyPreset = async (name: string): Promise<void> => {
    if (!detail) return;
    try {
      const r = await callMain<{ values: Record<string, unknown> }>("applyPreset", { recipe: detail.id, preset: name });
      setFormValues(seedFormValues(detail.paramFields, r.values));
      flash(`已套用 preset: ${name}`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  const deletePreset = async (name: string): Promise<void> => {
    if (!detail) return;
    try {
      await callMain("deletePreset", { recipe: detail.id, name });
      flash(`preset 已删除: ${name}`);
    } catch (e) {
      flash(msg(e), "error");
    }
  };

  // ---- 渲染 ----

  const rows: TraceRow[] = detail ? groupTraceSteps(detail.trace) : [];
  const pending = detail ? pendingSteps(detail.declaredSteps, detail.trace) : [];

  const toggleExpand = (key: string): void => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const toggleCollapse = (key: string): void => {
    setCollapsedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="app">
      <style>{BASE_STYLE}</style>
      <RecipeList list={list} selected={selected} onSelect={select} />
      <main className="right">
        {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}
        {loading && <div className="empty">加载中…</div>}
        {!loading && !detail && (
          <div className="empty">
            {list.length === 0
              ? "recipes/ 目录为空：放入 .yaml 配方后自动出现（改完即生效，无需重启）"
              : "选择左侧配方查看详情"}
          </div>
        )}
        {detail && (
          <>
            <header className="detail-head">
              <div className="head-line">
                <h1>{detail.name}</h1>
                {!detail.ok && <span className="tag tag-error" title={detail.errors.join("; ")}>invalid</span>}
                {detail.running && <span className="tag tag-running">运行中</span>}
                {detail.hotkeyState === "hotkey-conflict" && <span className="tag tag-conflict">热键冲突</span>}
              </div>
              <div className="head-meta">
                <span>{detail.id}</span>
                {detail.hotkey && <span>hotkey: {detail.hotkey}</span>}
                <span>onRun: {detail.onRun}</span>
                <span>onerror: {detail.onerror}</span>
                <span>{detail.stepCount} 步 · {detail.paramCount} 参数</span>
              </div>
              {!detail.ok && <div className="invalid-errors">{detail.errors.join("; ")}</div>}
              <div className="btn-row">
                <button type="button" className="primary" disabled={!detail.ok} onClick={() => void startRun("run")}>运行</button>
                <button type="button" disabled={!detail.ok} onClick={() => void startRun("dryRun")}>Dry Run</button>
                <button type="button" disabled={!detail.ok || detail.runs.length === 0} onClick={() => setPickerOpen(true)}>
                  从第 N 步重跑
                </button>
                <button type="button" disabled={!detail.running} onClick={() => void stopRun()}>停止</button>
                {detail.paramCount > 0 && (
                  <button type="button" onClick={() => setShowParams((v) => !v)}>参数</button>
                )}
                <button type="button" onClick={() => void copyPath()}>复制 YAML 路径</button>
              </div>
            </header>

            {detail.ok && detail.paramCount > 0 && showParams && (
              <section className="panel">
                <h2>参数</h2>
                <SchemaForm
                  fields={detail.paramFields}
                  values={formValues}
                  onChange={(name, v) => setFormValues((prev) => ({ ...prev, [name]: v }))}
                />
                <div className="preset-row">
                  <input
                    className="preset-name"
                    placeholder="preset 名"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                  />
                  <button type="button" onClick={() => void savePreset()}>另存为 preset</button>
                </div>
                {detail.presets.length > 0 && (
                  <div className="preset-list">
                    {detail.presets.map((p) => (
                      <div key={p.name} className="preset-item">
                        <span className="preset-item-name">{p.name}</span>
                        <button type="button" onClick={() => void applyPreset(p.name)}>套用</button>
                        <button type="button" onClick={() => void deletePreset(p.name)}>删除</button>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            <section className="panel trace-panel">
              <div className="trace-head">
                <h2>步骤 × 轨迹</h2>
                {detail.traceSource === "live" && <span className="tag tag-running">直播中</span>}
                {detail.runs.length > 0 && (
                  <select value={String(detail.runIndex)} onChange={(e) => selectRun(Number(e.target.value))}>
                    {detail.runs.map((r, i) => (
                      <option key={r.runId} value={i}>
                        #{i + 1} · {formatTime(r.startedAt)} · {r.status}{r.dryRun ? " · dry-run" : ""} · {formatMs(r.ms)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              {rows.length === 0 && pending.length === 0 && (
                <div className="empty">尚无运行记录（点「运行」或按热键触发）</div>
              )}
              <div className="trace-list">
                {rows.map((row, i) => {
                  const step = row.step;
                  const key = `${row.kind === "container" ? "c" : "s"}-${step.id}-${i}`;
                  return (
                    <TraceRowView
                      key={key}
                      row={row}
                      rowKey={key}
                      expandedKeys={expandedKeys}
                      collapsed={collapsedKeys.has(key)}
                      onToggleExpand={toggleExpand}
                      onToggleCollapse={() => toggleCollapse(key)}
                    />
                  );
                })}
                {pending.map((s, i) => (
                  <div key={`p-${s.id}-${i}`} className="trace-row pending-row">
                    <div className="trace-line">
                      <StatusDot status="pending" />
                      <span className="trace-id">{s.id}</span>
                      <span className="trace-action">{s.for ? "for" : s.action ?? ""}</span>
                      <span className="trace-ms">待运行</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {gateway && (
        <GatewayFormCard
          form={gateway}
          onFinish={(value) => {
            host.app.send({ type: "form-result", formId: gateway.formId, value });
            setGateway(null);
          }}
          onCancel={() => {
            host.app.send({ type: "form-cancel", formId: gateway.formId });
            setGateway(null);
          }}
        />
      )}
      {pickerOpen && detail && (
        <StepPicker
          detail={detail}
          onPick={(stepId) => {
            setPickerOpen(false);
            void startRun("rerun", { fromStep: stepId });
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 样式：语义 token（组件里不出现裸色值）+ <style> 注入
// ---------------------------------------------------------------------------

const BASE_STYLE = `
  :root {
    --bg: #f6f7f8; --card: #ffffff; --border: #d9dee3; --fg: #20262b; --muted: #6b7480;
    --primary: #1f6feb; --primary-fg: #ffffff;
    --ok: #1a9c5c; --error: #cf3f3f; --warn: #d08a16; --info: #6f42c1; --neutral: #98a1ab;
  }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; }
  body { margin: 0; font: 13px/1.5 system-ui, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); }
  button { padding: 4px 12px; border: 1px solid var(--border); border-radius: 5px; background: var(--card);
           color: var(--fg); cursor: pointer; font: inherit; }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-fg); }
  input, select { padding: 4px 8px; border: 1px solid var(--border); border-radius: 5px; font: inherit; }
  h1 { font-size: 16px; margin: 0; } h2 { font-size: 13px; margin: 0 0 8px; color: var(--muted); font-weight: 600; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-all; font: 12px/1.45 ui-monospace, Consolas, monospace; }

  .app { display: flex; height: 100%; }
  .left { width: 230px; flex-shrink: 0; border-right: 1px solid var(--border); background: var(--card);
          overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 2px; }
  .recipe-item { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
                 border: none; background: none; padding: 6px 8px; border-radius: 6px; }
  .recipe-item:hover { background: var(--bg); }
  .recipe-item.active { background: var(--bg); outline: 1px solid var(--border); }
  .recipe-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .recipe-hotkey { color: var(--muted); font-size: 11px; }
  .right { flex: 1; min-width: 0; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
  .empty { color: var(--muted); padding: 20px 8px; text-align: center; }

  .banner { position: sticky; top: -14px; z-index: 5; padding: 6px 10px; border-radius: 6px; font-size: 12px; }
  .banner.info { background: color-mix(in srgb, var(--primary) 10%, var(--card)); color: var(--primary); }
  .banner.error { background: color-mix(in srgb, var(--error) 10%, var(--card)); color: var(--error); }

  .detail-head .head-line { display: flex; align-items: center; gap: 8px; }
  .head-meta { display: flex; gap: 12px; color: var(--muted); font-size: 12px; margin-top: 4px; flex-wrap: wrap; }
  .invalid-errors { color: var(--error); font-size: 12px; margin-top: 6px; }
  .btn-row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
  .tag-error { color: var(--error); border-color: var(--error); }
  .tag-running { color: var(--primary); border-color: var(--primary); }
  .tag-conflict { color: var(--warn); border-color: var(--warn); }

  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .form { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 16px; }
  .field { display: flex; flex-direction: column; gap: 3px; font-size: 12px; }
  .field > input, .field > select { width: 100%; }
  .field-bool { flex-direction: row; align-items: center; gap: 6px; }
  .field-label { color: var(--muted); }

  .preset-row { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
  .preset-name { width: 160px; }
  .preset-list { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
  .preset-item { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .preset-item-name { flex: 1; }
  .preset-item button { padding: 2px 10px; font-size: 12px; }

  .trace-panel { flex: 1; min-height: 120px; }
  .trace-head { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .trace-head h2 { margin: 0; flex: 1; }
  .trace-head select { max-width: 340px; }
  .trace-list { display: flex; flex-direction: column; }
  .trace-row { border-bottom: 1px solid var(--bg); }
  .trace-row.pending-row { opacity: .7; }
  .trace-line { display: flex; align-items: center; gap: 8px; padding: 4px 2px; }
  .trace-line .caret { color: var(--muted); }
  .trace-line.container-line { cursor: pointer; }
  .trace-row.open > .trace-line { background: var(--bg); }
  .trace-detail { padding: 6px 10px 10px 24px; display: flex; flex-direction: column; gap: 4px; }
  .trace-detail .kv { display: flex; gap: 8px; font-size: 12px; }
  .trace-detail .k { color: var(--muted); min-width: 34px; }
  .trace-detail .err { color: var(--error); }
  .trace-children { padding-left: 20px; border-left: 2px solid var(--border); margin-left: 6px; }
  .trace-id { font-family: ui-monospace, Consolas, monospace; font-size: 12px; min-width: 90px; }
  .trace-action { color: var(--info); font-size: 12px; flex: 1; min-width: 0;
                  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .trace-ms { color: var(--muted); font-size: 11px; }
  .trace-iter { color: var(--muted); font-size: 11px; font-family: ui-monospace, Consolas, monospace; }
  .trace-iter-count { color: var(--muted); font-size: 11px; }

  .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; background: var(--neutral); }
  .st-ok { background: var(--ok); }
  .st-error { background: var(--error); }
  .st-skipped { background: var(--neutral); }
  .st-replayed { background: var(--info); }
  .st-cancelled { background: var(--warn); }
  .st-pending { background: transparent; border: 1.5px solid var(--neutral); }
  .list-ok { background: var(--ok); }
  .list-error { background: var(--error); }
  .list-conflict { background: var(--warn); }
  .list-running { background: var(--primary); animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: .35; } }

  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.28); display: flex;
             align-items: center; justify-content: center; z-index: 20; outline: none; }
  .card { background: var(--card); border-radius: 8px; padding: 16px 18px; min-width: 280px; max-width: 420px;
          box-shadow: 0 8px 28px rgba(0,0,0,.22); outline: none; }
  .card h2 { color: var(--fg); font-size: 15px; margin: 0 0 10px; }
  .card-body { color: var(--muted); white-space: pre-wrap; margin: 0 0 10px; }
  .card .form { grid-template-columns: 1fr; }
  .menu-list { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; }
  .menu-item { text-align: left; width: 100%; }
  .actions { display: flex; gap: 8px; margin-top: 12px; justify-content: flex-end; }
  .form-error { color: var(--error); font-size: 12px; margin-top: 6px; }
`;

createRoot(document.getElementById("root")!).render(<App />);
