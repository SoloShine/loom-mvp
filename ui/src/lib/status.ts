export const statusMeta: Record<string, { label: string; dot: string; pulse?: boolean }> = {
  running: { label: "运行中", dot: "bg-emerald-500", pulse: true },
  starting: { label: "启动中", dot: "bg-sky-500", pulse: true },
  stopping: { label: "停止中", dot: "bg-sky-500" },
  stopped: { label: "已停止", dot: "bg-zinc-400 dark:bg-zinc-600" },
  crashed: { label: "已崩溃", dot: "bg-red-500" },
  broken: { label: "异常", dot: "bg-red-500" },
};

export function statusText(status: string): string {
  return statusMeta[status]?.label ?? status;
}
