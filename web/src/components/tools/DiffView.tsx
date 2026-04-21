type Props = {
  path: string;
  oldText: string | null;
  newText: string;
};

// Simple line-based diff: LCS would be better, but a straight longest-common-
// prefix/suffix trim gives readable results for Edit-style diffs without a dep.
export function DiffView({ path, oldText, newText }: Props) {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");

  const rows = buildRows(oldLines, newLines);
  const isNewFile = oldText == null;

  return (
    <div className="rounded border border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px]">
        <span className="font-mono text-fg-muted">{path}</span>
        {isNewFile && <span className="text-accent">new file</span>}
      </div>
      <pre className="max-h-96 overflow-auto p-0 font-mono text-[12px] leading-[1.5]">
        {rows.map((r, i) => (
          <div
            key={i}
            className={
              r.kind === "add"
                ? "bg-accent/10 text-accent"
                : r.kind === "del"
                ? "bg-destructive/10 text-destructive"
                : "text-fg-muted"
            }
          >
            <span className="inline-block w-4 select-none px-2">
              {r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}
            </span>
            {r.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

type Row = { kind: "ctx" | "add" | "del"; text: string };

function buildRows(oldLines: string[], newLines: string[]): Row[] {
  let prefix = 0;
  const minLen = Math.min(oldLines.length, newLines.length);
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) prefix++;

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const rows: Row[] = [];
  for (let i = 0; i < prefix; i++) rows.push({ kind: "ctx", text: oldLines[i] });
  for (let i = prefix; i < oldLines.length - suffix; i++) rows.push({ kind: "del", text: oldLines[i] });
  for (let i = prefix; i < newLines.length - suffix; i++) rows.push({ kind: "add", text: newLines[i] });
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) rows.push({ kind: "ctx", text: oldLines[i] });
  return rows;
}
