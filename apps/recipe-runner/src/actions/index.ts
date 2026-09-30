// actions 出口：main.ts（动作接线）与测试共用。engine 不反向 import 这里
// （单向依赖：actions → engine types；main → actions + engine）。

export { buildHostActions, type HostDeps } from "./host";
export { buildUtilActions, globToRegExp, type FileEntry } from "./util";
export {
  buildUiActions, normalizeFields,
  type ShowForm, type ShowFormPayload, type UiField,
} from "./ui";
