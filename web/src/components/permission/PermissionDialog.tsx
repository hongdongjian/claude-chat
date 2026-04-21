import { useEffect, type RefObject } from "react";
import { useStore, type PendingPermission } from "@/store/sessions";
import type { WsClient } from "@/lib/ws-client";
import { ShieldAlert } from "lucide-react";

type Props = { wsClient: RefObject<WsClient | null> };

export function PermissionDialog({ wsClient }: Props) {
  const pending = useStore((s) => s.permissionQueue[0] ?? null);
  const resolvePermission = useStore((s) => s.resolvePermission);

  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reply("cancelled");
      if (e.key === "Enter") {
        const allow = pending.options.find((o) => o.kind === "allow_once") ?? pending.options[0];
        if (allow) reply("selected", allow.optionId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  if (!pending) return null;

  const reply = (outcome: "selected" | "cancelled", optionId?: string) => {
    wsClient.current?.send({
      type: "permission.reply",
      requestId: pending.requestId,
      optionId: optionId ?? "",
      outcome,
    });
    resolvePermission(pending.requestId);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ShieldAlert size={16} className="text-warning" />
          <div className="font-mono text-sm font-semibold">Permission required</div>
        </div>

        <ToolCallSummary call={pending} />

        <div className="flex flex-wrap gap-2 border-t border-border px-4 py-3">
          {pending.options.map((opt) => (
            <button
              key={opt.optionId}
              onClick={() => reply("selected", opt.optionId)}
              className={buttonClass(opt.kind)}
            >
              {opt.name}
            </button>
          ))}
          <button
            onClick={() => reply("cancelled")}
            className="ml-auto rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
          >
            Dismiss (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolCallSummary({ call }: { call: PendingPermission }) {
  const tc = call.toolCall;
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="font-mono text-[13px] text-fg">{tc.title ?? tc.toolCallId}</div>
      {tc.kind && (
        <div className="font-mono text-[11px] uppercase text-fg-muted">{tc.kind}</div>
      )}
      {tc.locations?.length ? (
        <div className="font-mono text-[11px] text-fg-muted">
          {tc.locations.map((l, i) => (
            <div key={i}>
              {l.path}
              {l.line != null ? `:${l.line}` : ""}
            </div>
          ))}
        </div>
      ) : null}
      {tc.rawInput !== undefined && (
        <pre className="max-h-60 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg">
          {safeJson(tc.rawInput)}
        </pre>
      )}
    </div>
  );
}

function buttonClass(kind: string): string {
  const base = "rounded px-3 py-1.5 text-sm font-medium";
  if (kind === "allow_once" || kind === "allow_always") {
    return `${base} bg-accent text-bg hover:brightness-110`;
  }
  if (kind === "reject_once" || kind === "reject_always") {
    return `${base} border border-destructive bg-destructive/10 text-destructive hover:bg-destructive/20`;
  }
  return `${base} border border-border text-fg hover:bg-surface`;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
