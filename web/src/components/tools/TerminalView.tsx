export function TerminalView({ terminalId }: { terminalId: string }) {
  return (
    <div className="rounded border border-border bg-black/60 p-2 font-mono text-[12px] text-fg-muted">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="inline-block h-2 w-2 rounded-full bg-info" />
        terminal <span className="text-fg">{terminalId}</span>
      </div>
      <div className="mt-1 text-[11px]">
        (live output via <code>terminal/output</code> not yet wired — M2 placeholder)
      </div>
    </div>
  );
}
