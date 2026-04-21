import { useEffect, useRef } from "react";
import { useStore } from "@/store/sessions";
import { WsClient } from "@/lib/ws-client";
import { AppShell } from "@/components/layout/AppShell";

const IDLE_UNLOAD_MS = 60 * 60_000;
const URL_PARAM = "w";

function readUrlWorkspace(): string | null {
  return new URLSearchParams(location.search).get(URL_PARAM);
}

function writeUrlWorkspace(workspaceId: string | null): void {
  const url = new URL(location.href);
  const current = url.searchParams.get(URL_PARAM);
  if (workspaceId) {
    if (current === workspaceId) return;
    url.searchParams.set(URL_PARAM, workspaceId);
  } else {
    if (current === null) return;
    url.searchParams.delete(URL_PARAM);
  }
  history.replaceState(null, "", url.toString());
}

export default function App() {
  const clientRef = useRef<WsClient | null>(null);
  const handleServerMessage = useStore((s) => s.handleServerMessage);
  const setConnected = useStore((s) => s.setConnected);
  const setCurrentSession = useStore((s) => s.setCurrentSession);
  const connected = useStore((s) => s.connected);
  const currentSessionId = useStore((s) => s.currentSessionId);
  const currentSession = useStore((s) =>
    s.currentSessionId ? s.sessions[s.currentSessionId] : null,
  );
  const sessions = useStore((s) => s.sessions);

  useEffect(() => {
    const url =
      (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws";
    const c = new WsClient({
      url,
      onMessage: handleServerMessage,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
    });
    clientRef.current = c;
    return () => c.dispose();
  }, [handleServerMessage, setConnected]);

  // URL <-> currentSessionId sync.
  // When a session is active, mirror its workspaceId into ?w=. Don't clear the
  // param when currentSession is null (e.g. during initial load before
  // sessions.list arrives) — that would race the "adopt from URL" effect and
  // wipe a legitimate deep-link on refresh.
  useEffect(() => {
    if (!currentSession) return;
    writeUrlWorkspace(currentSession.workspaceId);
  }, [currentSession]);

  // On mount / whenever the sessions list changes, adopt the session from
  // ?w=<workspaceId> if it exists and isn't already current. This handles both
  // the initial page load and browser back/forward.
  useEffect(() => {
    const desired = readUrlWorkspace();
    if (!desired) return;
    if (currentSession && currentSession.workspaceId === desired) return;
    const match = Object.values(sessions).find((s) => s.workspaceId === desired);
    if (match) setCurrentSession(match.sessionId);
  }, [sessions, currentSession, setCurrentSession]);

  useEffect(() => {
    const onPop = () => {
      const desired = readUrlWorkspace();
      const state = useStore.getState();
      if (!desired) {
        if (state.currentSessionId) state.setCurrentSession("");
        return;
      }
      const match = Object.values(state.sessions).find((s) => s.workspaceId === desired);
      if (match && match.sessionId !== state.currentSessionId) {
        state.setCurrentSession(match.sessionId);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // After WS (re)connect, if the currently-viewed session isn't loaded on the
  // server anymore, transparently re-load it.
  useEffect(() => {
    if (!connected) return;
    if (!currentSessionId || !currentSession) return;
    if (currentSession.loaded) return;
    clientRef.current?.send({
      type: "session.load",
      workspaceId: currentSession.workspaceId,
    });
  }, [connected, currentSessionId, currentSession]);

  // Drop non-active sessions from server memory after IDLE_UNLOAD_MS to bound
  // resource usage. When the user switches away, we schedule an idle drop for
  // the previous session; switching back before the timer fires cancels it.
  // If the session is still running a prompt when the timer fires, we defer —
  // idle time is only counted while the session is quiet.
  const prevCurrentRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevCurrentRef.current;
    prevCurrentRef.current = currentSessionId;
    if (!prev || prev === currentSessionId) return;
    let timer: number | undefined;
    const arm = () => {
      timer = window.setTimeout(() => {
        const st = useStore.getState();
        if (st.currentSessionId === prev) return;
        const sess = st.sessions[prev];
        if (!sess || !sess.loaded) return;
        if (sess.promptRunning) {
          arm();
          return;
        }
        clientRef.current?.send({ type: "session.idle", sessionId: prev });
        st.markSessionIdle(prev);
      }, IDLE_UNLOAD_MS);
    };
    arm();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [currentSessionId]);

  return <AppShell wsClient={clientRef} />;
}
