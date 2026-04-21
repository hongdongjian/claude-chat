import type { RefObject } from "react";
import { useStore } from "@/store/sessions";
import type { WsClient } from "@/lib/ws-client";
import { SessionList } from "@/components/sidebar/SessionList";
import { ChatWindow } from "@/components/chat/ChatWindow";
import { Composer } from "@/components/composer/Composer";
import { PermissionDialog } from "@/components/permission/PermissionDialog";
import { UserAskDialog } from "@/components/permission/UserAskDialog";
import { UsageBar } from "@/components/topbar/UsageBar";
import { ImageLightbox } from "@/components/chat/ImageLightbox";
import { Toasts } from "@/components/layout/Toasts";
import { Plus, Circle, Trash2 } from "lucide-react";

type Props = { wsClient: RefObject<WsClient | null> };

export function AppShell({ wsClient }: Props) {
  const connected = useStore((s) => s.connected);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const savedCount = useStore(
    (s) => Object.values(s.sessions).filter((sess) => !sess.loaded).length,
  );

  const onNewSession = () => wsClient.current?.send({ type: "session.new" });

  const onPurgeSaved = () => {
    const state = useStore.getState();
    const saved = Object.values(state.sessions).filter((sess) => !sess.loaded);
    if (saved.length === 0) return;
    const confirmed = window.confirm(
      `清理 ${saved.length} 个已保存（非在线）会话？\n对应 workspace 目录将被删除（不可恢复）。`,
    );
    if (!confirmed) return;
    for (const sess of saved) {
      wsClient.current?.send({
        type: "session.delete",
        workspaceId: sess.workspaceId,
        removeFiles: true,
      });
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-bg text-fg">
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">claude-chat</span>
        </div>
        <div className="flex items-center gap-4">
          <UsageBar sessionId={currentSessionId} />
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <Circle
              className={
                connected ? "fill-accent text-accent" : "fill-destructive text-destructive"
              }
              size={8}
            />
            {connected ? "connected" : "disconnected"}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface/40">
          <div className="flex h-10 items-center justify-between px-3">
            <span className="text-xs uppercase tracking-wide text-fg-muted">Sessions</span>
            <div className="flex items-center gap-1">
              <button
                onClick={onPurgeSaved}
                disabled={savedCount === 0}
                className="flex items-center justify-center rounded p-1 text-fg-muted transition-colors hover:bg-surface hover:text-destructive disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fg-muted"
                title={
                  savedCount === 0
                    ? "没有可清理的会话"
                    : `一键清理 ${savedCount} 个已保存会话`
                }
                aria-label="清理已保存会话"
              >
                <Trash2 size={14} />
              </button>
              <button
                onClick={onNewSession}
                className="flex items-center gap-1 rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface hover:text-fg"
                title="新建会话"
              >
                <Plus size={14} />
                New
              </button>
            </div>
          </div>
          <SessionList wsClient={wsClient} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {currentSessionId ? (
            <>
              <ChatWindow sessionId={currentSessionId} />
              <Composer sessionId={currentSessionId} wsClient={wsClient} />
            </>
          ) : (
            <EmptyState onNewSession={onNewSession} />
          )}
        </main>
      </div>
      <PermissionDialog wsClient={wsClient} />
      <UserAskDialog wsClient={wsClient} />
      <ImageLightbox />
      <Toasts />
    </div>
  );
}

function EmptyState({ onNewSession }: { onNewSession: () => void }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-fg-muted">
      <div className="font-mono text-sm">no active session</div>
      <button
        onClick={onNewSession}
        className="rounded border border-border bg-surface px-3 py-1.5 text-sm text-fg hover:border-accent hover:text-accent"
      >
        + Start new session
      </button>
    </div>
  );
}
