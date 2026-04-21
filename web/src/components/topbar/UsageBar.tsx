import { useStore } from "@/store/sessions";
import { Gauge } from "lucide-react";

export function UsageBar({ sessionId }: { sessionId: string | null }) {
  const usage = useStore((s) => (sessionId ? s.sessions[sessionId]?.usage ?? null : null));
  if (!usage || usage.size === 0) return null;

  const pct = Math.min(100, Math.round((usage.used / usage.size) * 100));
  const tone = pct >= 90 ? "text-destructive" : pct >= 70 ? "text-warning" : "text-fg-muted";

  return (
    <div className="flex items-center gap-2 font-mono text-[11px]">
      <Gauge size={12} className={tone} />
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-border">
        <div
          className={
            pct >= 90 ? "h-full bg-destructive" : pct >= 70 ? "h-full bg-warning" : "h-full bg-accent"
          }
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={tone}>
        {formatTokens(usage.used)}/{formatTokens(usage.size)}
      </span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
