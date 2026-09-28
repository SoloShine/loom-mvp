import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { statusMeta } from "@/lib/status";

export function Card({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/70 bg-card">
      <header className="flex items-center justify-between border-b border-border/60 px-4 py-2.5">
        <h2 className="text-[13px] font-medium text-foreground/90">{title}</h2>
        {action}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-[13px] first:pt-0 last:pb-0">
      <span className="w-16 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 select-none items-center rounded border border-border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

export function StatusDot({ status }: { status: string }) {
  const meta = statusMeta[status];
  return (
    <span className="relative flex size-2 shrink-0">
      {meta?.pulse && (
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", meta.dot)} />
      )}
      <span className={cn("relative inline-flex size-2 rounded-full", meta?.dot ?? "bg-zinc-400")} />
    </span>
  );
}
