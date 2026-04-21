import { CircleSlash } from "lucide-react";

type Props = { text: string };

export function NoticeBubble({ text }: Props) {
  return (
    <div className="flex justify-center">
      <div className="flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3 py-1 text-[11px] text-fg-muted">
        <CircleSlash size={12} className="text-warning" />
        <span>{text}</span>
      </div>
    </div>
  );
}
