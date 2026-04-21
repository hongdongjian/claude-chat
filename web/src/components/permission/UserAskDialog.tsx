import { useEffect, useState, type RefObject } from "react";
import { useStore } from "@/store/sessions";
import type { WsClient } from "@/lib/ws-client";
import { MessageCircleQuestion } from "lucide-react";

type Props = { wsClient: RefObject<WsClient | null> };

export function UserAskDialog({ wsClient }: Props) {
  const ask = useStore((s) => s.userAskQueue[0] ?? null);
  const resolveUserAsk = useStore((s) => s.resolveUserAsk);
  const [text, setText] = useState("");

  useEffect(() => {
    setText("");
  }, [ask?.askId]);

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reply("cancelled");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask]);

  if (!ask) return null;

  const reply = (outcome: "selected" | "cancelled", optionId?: string, freeText?: string) => {
    wsClient.current?.send({
      type: "user.ask.reply",
      askId: ask.askId,
      outcome,
      optionId,
      text: freeText,
    });
    resolveUserAsk(ask.askId);
  };

  const hasOptions = ask.options.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg overflow-hidden rounded-md border border-border bg-surface shadow-2xl">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MessageCircleQuestion size={16} className="text-info" />
          <div className="font-mono text-sm font-semibold">Agent asks</div>
        </div>
        <div className="space-y-3 px-4 py-3">
          <div className="whitespace-pre-wrap text-sm text-fg">{ask.question}</div>
          {hasOptions && (
            <div className="flex flex-col gap-1">
              {ask.options.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => reply("selected", opt.id, text.trim() || undefined)}
                  className="rounded border border-border px-3 py-2 text-left text-sm hover:border-accent hover:text-accent"
                >
                  <div className="font-medium">{opt.label}</div>
                  {opt.description && (
                    <div className="mt-0.5 text-xs text-fg-muted">{opt.description}</div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-1">
            {hasOptions && (
              <div className="text-[11px] text-fg-muted">
                或者自由输入（可选，会与选项一起发给 agent）：
              </div>
            )}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={
                hasOptions ? "补充说明或直接用这段文本回复…" : "Type your answer..."
              }
              className="h-24 w-full resize-y rounded border border-border bg-bg px-2 py-1 font-mono text-sm text-fg"
              autoFocus={!hasOptions}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={() => reply("cancelled")}
            className="rounded border border-border px-3 py-1.5 text-sm text-fg-muted hover:text-fg"
          >
            Cancel (Esc)
          </button>
          <button
            onClick={() => reply("selected", "", text)}
            disabled={!text.trim()}
            className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-bg hover:brightness-110 disabled:opacity-50"
          >
            {hasOptions ? "以文本发送" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
