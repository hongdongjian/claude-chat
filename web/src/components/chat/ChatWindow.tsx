import { useEffect, useRef, useState } from "react";
import { useStore } from "@/store/sessions";
import { UserBubble } from "./UserBubble";
import { AssistantBubble } from "./AssistantBubble";
import { ThoughtBlock } from "./ThoughtBlock";
import { ToolCallCard } from "@/components/tools/ToolCallCard";
import { ArrowDown, Loader2 } from "lucide-react";

export function ChatWindow({ sessionId }: { sessionId: string }) {
  const session = useStore((s) => s.sessions[sessionId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const atBottom = distanceFromBottom < 24;
      if (atBottom !== pinnedRef.current) {
        pinnedRef.current = atBottom;
        setPinned(atBottom);
      }
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [session?.events]);

  if (!session) return null;

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setPinned(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        className="flex h-full flex-col gap-3 overflow-y-auto px-6 py-6"
        style={{ contain: "layout" }}
      >
        <div className="font-mono text-[11px] text-fg-muted">
          workspace: {session.cwd}
        </div>
        {session.events.length === 0 && !session.loaded && <LoadingSessionIndicator />}
        {session.events.length === 0 && session.loaded && (
          <div className="text-sm text-fg-muted">输入消息开始和 Claude 对话…</div>
        )}
        {session.events.map((e) => {
          if (e.kind === "user") return <UserBubble key={e.id} text={e.text} images={e.images} />;
          if (e.kind === "assistant") return <AssistantBubble key={e.id} text={e.text} done={e.done} />;
          if (e.kind === "thought") return <ThoughtBlock key={e.id} text={e.text} done={e.done} />;
          if (e.kind === "tool") return <ToolCallCard key={e.id} call={e.call} />;
          return null;
        })}
        {session.promptRunning && <RunningIndicator />}
      </div>

      {!pinned && (
        <button
          onClick={jumpToBottom}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg shadow-lg hover:border-accent hover:text-accent"
        >
          <ArrowDown size={12} />
          New messages
        </button>
      )}
    </div>
  );
}

function RunningIndicator() {
  return (
    <div className="flex items-center gap-2 text-xs text-fg-muted">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-info opacity-75"></span>
        <span className="relative inline-flex h-2 w-2 rounded-full bg-info"></span>
      </span>
      Claude is working…
    </div>
  );
}

function LoadingSessionIndicator() {
  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2 text-xs text-fg-muted">
        <Loader2 size={14} className="animate-spin text-accent" />
        正在加载会话历史…
      </div>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-4 w-full animate-pulse rounded bg-surface"
            style={{ maxWidth: i === 0 ? "60%" : i === 1 ? "85%" : "45%" }}
          />
        ))}
      </div>
    </div>
  );
}
