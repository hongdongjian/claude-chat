import { useState } from "react";
import type { ToolCallState } from "@/store/sessions";
import { DiffView } from "./DiffView";
import { TerminalView } from "./TerminalView";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Pencil,
  Trash2,
  MoveRight,
  Search,
  Terminal as TerminalIcon,
  Brain,
  Globe,
  Settings2,
  Wrench,
  Loader2,
  Check,
  X,
  Circle,
} from "lucide-react";

type Props = { call: ToolCallState };

const KIND_ICON = {
  read: FileText,
  edit: Pencil,
  delete: Trash2,
  move: MoveRight,
  search: Search,
  execute: TerminalIcon,
  think: Brain,
  fetch: Globe,
  switch_mode: Settings2,
  other: Wrench,
} as const;

export function ToolCallCard({ call }: Props) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[call.kind ?? "other"] ?? Wrench;

  return (
    <div className="rounded border border-border bg-surface/50">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Icon size={14} className="text-fg-muted" />
        <StatusDot status={call.status} />
        <span className="flex-1 truncate font-mono text-[13px]">{call.title}</span>
        {call.kind && (
          <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-fg-muted">
            {call.kind}
          </span>
        )}
      </button>

      {open && (
        <div className="border-t border-border px-3 py-2 space-y-2">
          {call.locations.length > 0 && (
            <div className="font-mono text-[11px] text-fg-muted">
              {call.locations.map((l, i) => (
                <div key={i}>
                  {l.path}
                  {l.line != null ? `:${l.line}` : ""}
                </div>
              ))}
            </div>
          )}

          {call.rawInput !== undefined && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-fg-muted">input</summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg">
                {safeJson(call.rawInput)}
              </pre>
            </details>
          )}

          {call.content.map((block, i) => {
            if (block.type === "content") {
              return (
                <pre
                  key={i}
                  className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-bg p-2 font-mono text-[12px] text-fg"
                >
                  {block.text}
                </pre>
              );
            }
            if (block.type === "diff") {
              return <DiffView key={i} path={block.path} oldText={block.oldText} newText={block.newText} />;
            }
            if (block.type === "terminal") {
              return <TerminalView key={i} terminalId={block.terminalId} />;
            }
            return null;
          })}

          {call.rawOutput !== undefined && call.content.length === 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer text-fg-muted">output</summary>
              <pre className="mt-1 max-h-80 overflow-auto rounded bg-bg p-2 font-mono text-[11px] text-fg">
                {safeJson(call.rawOutput)}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function StatusDot({ status }: { status: ToolCallState["status"] }) {
  if (status === "in_progress")
    return <Loader2 size={12} className="animate-spin text-info" />;
  if (status === "completed") return <Check size={12} className="text-accent" />;
  if (status === "failed") return <X size={12} className="text-destructive" />;
  return <Circle size={10} className="text-fg-muted" />;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
