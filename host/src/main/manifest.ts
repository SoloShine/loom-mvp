import yaml from "js-yaml";

export interface CommandDef {
  id: string;
  title: string;
}

export interface UiDef {
  type: "none" | "window" | "floating" | "overlay";
  width?: number;
  height?: number;
}

export interface Manifest {
  id: string;
  name: string;
  version: string;
  entry: string;
  ui: UiDef;
  commands: CommandDef[];
  hotkeys: Record<string, string>;
  permissions: string[];
}

export interface ParsedManifest {
  ok: boolean;
  manifest?: Manifest;
  errors: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const UI_TYPES = ["none", "window", "floating", "overlay"];

export function parseManifest(text: string, dirName: string): ParsedManifest {
  const errors: string[] = [];
  let raw: any;
  try {
    raw = yaml.load(text);
  } catch (e: any) {
    return { ok: false, errors: [`app.yaml 解析失败: ${e?.message ?? e}`] };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["app.yaml 为空或不是对象"] };
  }

  const id = typeof raw.id === "string" ? raw.id : "";
  if (!id) errors.push("缺少 id");
  else if (!ID_RE.test(id)) errors.push(`id 非法(需 ${ID_RE}): ${id}`);
  else if (id !== dirName) errors.push(`id (${id}) 与目录名 (${dirName}) 不一致`);

  if (typeof raw.name !== "string" || !raw.name) errors.push("缺少 name");
  if (typeof raw.version !== "string" || !raw.version) errors.push("缺少 version");
  if (typeof raw.entry !== "string" || !raw.entry) errors.push("缺少 entry");

  const uiRaw = raw.ui ?? {};
  const ui: UiDef = {
    type: UI_TYPES.includes(uiRaw?.type) ? uiRaw.type : "none",
    width: typeof uiRaw?.width === "number" ? uiRaw.width : undefined,
    height: typeof uiRaw?.height === "number" ? uiRaw.height : undefined,
  };
  if (raw.ui && !UI_TYPES.includes(raw.ui.type)) {
    errors.push(`ui.type 非法: ${raw.ui.type}(应为 none/window/floating/overlay)`);
  }

  const commands: CommandDef[] = [];
  if (raw.commands != null) {
    if (!Array.isArray(raw.commands)) errors.push("commands 必须是数组");
    else {
      for (const c of raw.commands) {
        if (!c || typeof c.id !== "string" || !ID_RE.test(c.id)) {
          errors.push(`command.id 非法: ${JSON.stringify(c)}`);
          continue;
        }
        commands.push({ id: c.id, title: typeof c.title === "string" ? c.title : c.id });
      }
    }
  }

  const hotkeys: Record<string, string> = {};
  if (raw.hotkeys != null) {
    if (typeof raw.hotkeys !== "object") errors.push("hotkeys 必须是映射(command id → 快捷键)");
    else {
      for (const [cmd, combo] of Object.entries(raw.hotkeys)) {
        if (typeof combo !== "string") errors.push(`hotkey ${cmd} 的值必须是字符串`);
        else if (!commands.some((c) => c.id === cmd)) errors.push(`hotkey ${cmd} 没有对应的 command`);
        else hotkeys[cmd] = combo;
      }
    }
  }

  const permissions: string[] = Array.isArray(raw.permissions)
    ? raw.permissions.filter((p: unknown) => typeof p === "string")
    : [];

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    errors: [],
    manifest: {
      id,
      name: raw.name,
      version: raw.version,
      entry: raw.entry,
      ui,
      commands,
      hotkeys,
      permissions,
    },
  };
}
