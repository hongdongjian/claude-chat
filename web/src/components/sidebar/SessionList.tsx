import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useStore } from "@/store/sessions";
import type { WsClient } from "@/lib/ws-client";
import { cn } from "@/lib/cn";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";

type Props = { wsClient: RefObject<WsClient | null> };

type MenuState = { sessionId: string; x: number; y: number } | null;

export function SessionList({ wsClient }: Props) {
  const sessions = useStore((s) => s.sessions);
  const currentId = useStore((s) => s.currentSessionId);
  const setCurrent = useStore((s) => s.setCurrentSession);
  const [menu, setMenu] = useState<MenuState>(null);

  const list = Object.values(sessions).sort((a, b) => b.lastActiveAt - a.lastActiveAt);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("click", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("click", close);
    };
  }, [menu]);

  if (list.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-fg-muted">还没有会话。点右上角 + New。</div>
    );
  }

  const openSession = (sid: string) => {
    setCurrent(sid);
  };

  const rename = (sid: string) => {
    const sess = sessions[sid];
    const next = window.prompt("重命名", sess.title);
    if (next && next.trim() && next !== sess.title) {
      wsClient.current?.send({
        type: "session.rename",
        workspaceId: sess.workspaceId,
        title: next.trim(),
      });
    }
    setMenu(null);
  };

  const remove = (sid: string) => {
    const sess = sessions[sid];
    const confirmed = window.confirm(
      `删除 "${sess.title}"？\nworkspace 目录也会被删除（不可恢复）。`,
    );
    if (confirmed) {
      wsClient.current?.send({
        type: "session.delete",
        workspaceId: sess.workspaceId,
        removeFiles: true,
      });
    }
    setMenu(null);
  };

  const toggleMenu = (e: React.MouseEvent<HTMLButtonElement>, sid: string) => {
    e.stopPropagation();
    if (menu?.sessionId === sid) {
      setMenu(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const MENU_WIDTH = 128;
    const MENU_HEIGHT = 72;
    let x = rect.right - MENU_WIDTH;
    let y = rect.bottom + 4;
    if (x < 8) x = rect.left;
    if (y + MENU_HEIGHT > window.innerHeight) y = rect.top - MENU_HEIGHT - 4;
    setMenu({ sessionId: sid, x, y });
  };

  return (
    <div className="flex flex-col gap-0.5 overflow-y-auto px-1.5 py-1">
      {list.map((s) => {
        const active = s.sessionId === currentId;
        return (
          <div key={s.sessionId} className="relative group">
            <button
              onClick={() => openSession(s.sessionId)}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 pr-7 text-left text-xs",
                active ? "bg-surface text-fg" : "text-fg-muted hover:bg-surface/60 hover:text-fg",
              )}
            >
              <span className="w-full truncate">{s.title}</span>
              <span className="flex w-full items-center gap-1 font-mono text-[10px] text-fg-muted">
                <span>{s.workspaceId.slice(0, 8)}</span>
                <span>·</span>
                <span>{formatRelative(s.lastActiveAt)}</span>
                {s.loaded ? (
                  <span className="ml-auto flex items-center gap-1 rounded border border-accent/40 bg-accent/10 px-1 text-[9px] text-accent">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent" />
                    online
                  </span>
                ) : (
                  <span className="ml-auto rounded border border-border px-1 text-[9px] text-fg-muted">
                    saved
                  </span>
                )}
              </span>
            </button>
            <button
              onClick={(e) => toggleMenu(e, s.sessionId)}
              className="absolute right-1 top-1.5 rounded p-1 text-fg-muted opacity-0 hover:bg-bg hover:text-fg group-hover:opacity-100"
            >
              <MoreHorizontal size={14} />
            </button>
          </div>
        );
      })}
      {menu &&
        createPortal(
          <div
            style={{ position: "fixed", left: menu.x, top: menu.y, width: 128 }}
            className="z-50 flex flex-col rounded border border-border bg-surface py-1 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => rename(menu.sessionId)}
              className="flex items-center gap-2 px-2 py-1.5 text-left hover:bg-bg"
            >
              <Pencil size={12} /> 重命名
            </button>
            <button
              onClick={() => remove(menu.sessionId)}
              className="flex items-center gap-2 px-2 py-1.5 text-left text-destructive hover:bg-bg"
            >
              <Trash2 size={12} /> 删除
            </button>
          </div>,
          document.body,
        )}
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}
