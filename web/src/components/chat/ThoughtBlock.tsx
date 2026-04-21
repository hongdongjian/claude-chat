import { useState } from "react";
import { Brain, ChevronDown, ChevronRight } from "lucide-react";

export function ThoughtBlock({ text, done }: { text: string; done: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = text.split("\n")[0].slice(0, 80);
  return (
    <div className="rounded border border-border bg-surface/30 text-[12px]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-fg-muted hover:text-fg"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span className="font-mono uppercase tracking-wide text-[10px]">thinking</span>
        {!open && <span className="truncate text-fg-muted">{preview}</span>}
        {!done && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-info" />}
      </button>
      {open && (
        <pre className="border-t border-border px-3 py-2 whitespace-pre-wrap font-mono text-[12px] text-fg-muted">
          {text}
        </pre>
      )}
    </div>
  );
}
