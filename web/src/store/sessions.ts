import { create } from "zustand";
import type { WsServerMessage, ToolCallView, PermissionOption } from "@claude-chat/shared";

export type UserEvent = {
  kind: "user";
  id: string;
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
};
export type AssistantEvent = { kind: "assistant"; id: string; text: string; done: boolean };
export type ThoughtEvent = { kind: "thought"; id: string; text: string; done: boolean };
export type ToolCallEvent = {
  kind: "tool"; id: string; toolCallId: string; call: ToolCallState;
};
export type SessionEvent = UserEvent | AssistantEvent | ThoughtEvent | ToolCallEvent;

export type ToolCallContentBlock =
  | { type: "content"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export type ToolCallState = {
  toolCallId: string;
  title: string;
  kind?: ToolCallView["kind"];
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  rawOutput?: unknown;
  content: ToolCallContentBlock[];
  locations: Array<{ path: string; line?: number }>;
};

export type PendingPermission = {
  requestId: string;
  sessionId: string;
  toolCall: ToolCallView;
  options: PermissionOption[];
};

export type PendingUserAsk = {
  askId: string;
  question: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect: boolean;
};

export type PlanEntry = {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
};

export type UsageSummary = { used: number; size: number };

export type ToastMessage = { id: string; level: "error" | "info"; text: string };

export type SessionState = {
  sessionId: string;
  workspaceId: string;
  cwd: string;
  title: string;
  events: SessionEvent[];
  toolCallIndex: Record<string, number>; // toolCallId -> index into events
  promptRunning: boolean;
  plan: PlanEntry[];
  usage: UsageSummary | null;
  loaded: boolean;
  lastActiveAt: number;
};

type Store = {
  connected: boolean;
  currentSessionId: string | null;
  sessions: Record<string, SessionState>;
  permissionQueue: PendingPermission[];
  userAskQueue: PendingUserAsk[];
  lightboxSrc: string | null;
  toasts: ToastMessage[];
  setConnected: (v: boolean) => void;
  setCurrentSession: (id: string) => void;
  handleServerMessage: (msg: WsServerMessage) => void;
  appendUserMessage: (
    sessionId: string,
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
  ) => void;
  resolvePermission: (requestId: string) => void;
  resolveUserAsk: (askId: string) => void;
  markSessionIdle: (sessionId: string) => void;
  openLightbox: (src: string) => void;
  closeLightbox: () => void;
  pushToast: (level: ToastMessage["level"], text: string) => void;
  dismissToast: (id: string) => void;
};

let seq = 0;
const nextId = () => `e${Date.now()}-${++seq}`;

type RawUpdate = {
  sessionUpdate: string;
  content?:
    | { type: "text"; text?: string }
    | { type: "image"; data?: string; mimeType?: string }
    | { type: string; text?: string; data?: string; mimeType?: string }
    | null;
  toolCallId?: string;
  title?: string;
  kind?: ToolCallView["kind"];
  status?: ToolCallState["status"];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: Array<{ path: string; line?: number | null }>;
};

type RawToolContentItem =
  | { type: "content"; content?: { type: string; text?: string } }
  | { type: "diff"; path: string; oldText?: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

function extractContentBlocks(raw: unknown): ToolCallContentBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCallContentBlock[] = [];
  for (const item of raw as RawToolContentItem[]) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "content" && item.content?.type === "text") {
      out.push({ type: "content", text: item.content.text ?? "" });
    } else if (item.type === "diff") {
      out.push({ type: "diff", path: item.path, oldText: item.oldText ?? null, newText: item.newText });
    } else if (item.type === "terminal") {
      out.push({ type: "terminal", terminalId: item.terminalId });
    }
  }
  return out;
}

function applyToolCallEvent(cur: SessionState, u: RawUpdate & { content?: unknown }): SessionState {
  const id = u.toolCallId;
  if (!id) return cur;
  const existingIdx = cur.toolCallIndex[id];
  const contentBlocks = extractContentBlocks(u.content);
  if (existingIdx == null) {
    const call: ToolCallState = {
      toolCallId: id,
      title: u.title ?? id,
      kind: u.kind,
      status: u.status ?? "pending",
      rawInput: u.rawInput,
      rawOutput: u.rawOutput,
      content: contentBlocks,
      locations: (u.locations ?? []).map((l) => ({ path: l.path, line: l.line ?? undefined })),
    };
    const ev: ToolCallEvent = { kind: "tool", id: nextId(), toolCallId: id, call };
    const events = [...cur.events, ev];
    const toolCallIndex = { ...cur.toolCallIndex, [id]: events.length - 1 };
    return { ...cur, events, toolCallIndex };
  }
  const prev = cur.events[existingIdx];
  if (prev.kind !== "tool") return cur;
  const updatedCall: ToolCallState = {
    ...prev.call,
    title: u.title ?? prev.call.title,
    kind: u.kind ?? prev.call.kind,
    status: u.status ?? prev.call.status,
    rawInput: u.rawInput !== undefined ? u.rawInput : prev.call.rawInput,
    rawOutput: u.rawOutput !== undefined ? u.rawOutput : prev.call.rawOutput,
    content: contentBlocks.length > 0 ? contentBlocks : prev.call.content,
    locations:
      u.locations !== undefined
        ? u.locations.map((l) => ({ path: l.path, line: l.line ?? undefined }))
        : prev.call.locations,
  };
  const events = cur.events.map((e, i) =>
    i === existingIdx ? { ...prev, call: updatedCall } : e,
  );
  return { ...cur, events };
}

function appendChunk(
  cur: SessionState,
  kind: "assistant" | "thought",
  text: string,
): SessionState {
  const events = [...cur.events];
  const last = events[events.length - 1];
  if (last && last.kind === kind && !last.done) {
    events[events.length - 1] = { ...last, text: last.text + text } as SessionEvent;
  } else {
    const ev: AssistantEvent | ThoughtEvent = { kind, id: nextId(), text, done: false };
    events.push(ev);
  }
  return { ...cur, events };
}

// ACP replays past user prompts as user_message_chunk during loadSession.
// It also echoes the just-sent prompt as chunks during the live turn (the
// `replay-user-messages` extra arg). We ignore live echoes entirely — the UI
// already appended the full user event via appendUserMessage — and merge
// replay chunks (text + image) into a single user event per conversational
// turn for historic sessions.
const ACP_ENVELOPE_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<local-command-stdout>",
  "<local-command-stderr>",
];

function isAcpCommandEnvelope(text: string): boolean {
  const t = text.trim();
  return ACP_ENVELOPE_PREFIXES.some((p) => t.startsWith(p));
}

type UserChunkContent =
  | { type: "text"; text?: string }
  | { type: "image"; data?: string; mimeType?: string }
  | { type: string; text?: string; data?: string; mimeType?: string }
  | null
  | undefined;

function appendUserChunk(cur: SessionState, content: UserChunkContent): SessionState {
  if (!content) return cur;
  // Live turn: ACP echoes what we just sent; UI already has it.
  if (cur.promptRunning) return cur;
  if (content.type === "text") {
    const text = content.text ?? "";
    if (!text) return cur;
    if (isAcpCommandEnvelope(text)) return cur;
    const events = [...cur.events];
    const last = events[events.length - 1];
    if (last && last.kind === "user") {
      if (last.text === text) return cur;
      const merged = last.text ? `${last.text}\n${text}` : text;
      events[events.length - 1] = { ...last, text: merged };
      return { ...cur, events };
    }
    events.push({ kind: "user", id: nextId(), text } as UserEvent);
    return { ...cur, events };
  }
  if (
    content.type === "image" &&
    typeof content.data === "string" &&
    typeof content.mimeType === "string"
  ) {
    const img = { data: content.data, mimeType: content.mimeType };
    const events = [...cur.events];
    const last = events[events.length - 1];
    if (last && last.kind === "user") {
      const images = [...(last.images ?? []), img];
      events[events.length - 1] = { ...last, images };
      return { ...cur, events };
    }
    events.push({ kind: "user", id: nextId(), text: "", images: [img] } as UserEvent);
    return { ...cur, events };
  }
  return cur;
}

function markStreamingDone(cur: SessionState): SessionState {
  const events = cur.events.map((e) =>
    (e.kind === "assistant" || e.kind === "thought") && !e.done ? { ...e, done: true } : e,
  );
  return { ...cur, events };
}

export const useStore = create<Store>((set) => ({
  connected: false,
  currentSessionId: null,
  sessions: {},
  permissionQueue: [],
  userAskQueue: [],
  lightboxSrc: null,
  toasts: [],
  setConnected: (v) =>
    set((s) => {
      if (v === s.connected) return { connected: v };
      if (!v) {
        // Disconnect: any in-flight prompts on the old bridge cannot complete
        // on this client anymore. Clear running/streaming flags so the UI
        // doesn't show a phantom "Claude is working..." forever.
        const sessions: Record<string, SessionState> = {};
        for (const [k, sess] of Object.entries(s.sessions)) {
          sessions[k] =
            sess.promptRunning
              ? { ...markStreamingDone(sess), promptRunning: false }
              : sess;
        }
        return { connected: false, sessions };
      }
      // Reconnect: server's in-memory session map was lost (e.g. server
      // restart, WS drop). Drop our `loaded` flags so the UI shows "saved"
      // again; App.tsx will re-load the current session automatically.
      const sessions: Record<string, SessionState> = {};
      for (const [k, sess] of Object.entries(s.sessions)) {
        sessions[k] = sess.loaded ? { ...sess, loaded: false } : sess;
      }
      return { connected: true, sessions };
    }),
  setCurrentSession: (id) => set({ currentSessionId: id }),
  appendUserMessage: (sessionId, text, images) =>
    set((s) => {
      const cur = s.sessions[sessionId];
      if (!cur) return s;
      const ev: UserEvent = { kind: "user", id: nextId(), text };
      if (images && images.length > 0) ev.images = images;
      const events = [...cur.events, ev];
      return {
        sessions: {
          ...s.sessions,
          [sessionId]: { ...cur, events, promptRunning: true },
        },
      };
    }),
  resolvePermission: (requestId) =>
    set((s) => ({
      permissionQueue: s.permissionQueue.filter((p) => p.requestId !== requestId),
    })),
  resolveUserAsk: (askId) =>
    set((s) => ({
      userAskQueue: s.userAskQueue.filter((p) => p.askId !== askId),
    })),
  markSessionIdle: (sessionId) =>
    set((s) => {
      const cur = s.sessions[sessionId];
      if (!cur || !cur.loaded) return s;
      return {
        sessions: { ...s.sessions, [sessionId]: { ...cur, loaded: false } },
      };
    }),
  openLightbox: (src) => set({ lightboxSrc: src }),
  closeLightbox: () => set({ lightboxSrc: null }),
  pushToast: (level, text) =>
    set((s) => ({
      toasts: [...s.toasts, { id: nextId(), level, text }],
    })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  handleServerMessage: (msg) =>
    set((s) => {
      switch (msg.type) {
        case "session.created": {
          const sess: SessionState = {
            sessionId: msg.sessionId,
            workspaceId: msg.workspaceId,
            cwd: msg.cwd,
            title: msg.title,
            events: [],
            toolCallIndex: {},
            promptRunning: false,
            plan: [],
            usage: null,
            loaded: true,
            lastActiveAt: Date.now(),
          };
          return {
            sessions: { ...s.sessions, [msg.sessionId]: sess },
            currentSessionId: msg.sessionId,
          };
        }
        case "sessions.list": {
          const next = { ...s.sessions };
          for (const p of msg.sessions) {
            if (next[p.sessionId]) continue; // keep existing (loaded) state
            next[p.sessionId] = {
              sessionId: p.sessionId,
              workspaceId: p.workspaceId,
              cwd: p.cwd,
              title: p.title,
              events: [],
              toolCallIndex: {},
              promptRunning: false,
              plan: [],
              usage: null,
              loaded: false,
              lastActiveAt: p.lastActiveAt,
            };
          }
          return { sessions: next };
        }
        case "session.loaded": {
          // Migration path: the server rebound this workspace to a new
          // sessionId because the old ACP session was unresumable. Move
          // the existing entry under the new key so UI state and the URL
          // param stay consistent.
          const prevId = msg.previousSessionId;
          if (prevId && prevId !== msg.sessionId) {
            const prev = s.sessions[prevId];
            const next = { ...s.sessions };
            delete next[prevId];
            const base: SessionState = prev ?? {
              sessionId: msg.sessionId,
              workspaceId: msg.workspaceId,
              cwd: msg.cwd,
              title: msg.title,
              events: [],
              toolCallIndex: {},
              promptRunning: false,
              plan: [],
              usage: null,
              loaded: false,
              lastActiveAt: Date.now(),
            };
            next[msg.sessionId] = {
              ...base,
              sessionId: msg.sessionId,
              loaded: true,
              lastActiveAt: Date.now(),
              // Drop anything left in a stale running state; the old ACP
              // session is gone.
              promptRunning: false,
            };
            return {
              sessions: next,
              currentSessionId:
                s.currentSessionId === prevId ? msg.sessionId : s.currentSessionId,
            };
          }
          const cur = s.sessions[msg.sessionId];
          if (!cur) return s;
          return {
            sessions: {
              ...s.sessions,
              [msg.sessionId]: { ...cur, loaded: true, lastActiveAt: Date.now() },
            },
            currentSessionId: msg.sessionId,
          };
        }
        case "session.renamed": {
          const sid = Object.keys(s.sessions).find(
            (k) => s.sessions[k].workspaceId === msg.workspaceId,
          );
          if (!sid) return s;
          return {
            sessions: { ...s.sessions, [sid]: { ...s.sessions[sid], title: msg.title } },
          };
        }
        case "session.deleted": {
          const sid = Object.keys(s.sessions).find(
            (k) => s.sessions[k].workspaceId === msg.workspaceId,
          );
          if (!sid) return s;
          const next = { ...s.sessions };
          delete next[sid];
          return {
            sessions: next,
            currentSessionId: s.currentSessionId === sid ? null : s.currentSessionId,
          };
        }
        case "session.update": {
          const cur = s.sessions[msg.sessionId];
          if (!cur) return s;
          const u = msg.update as RawUpdate;
          let next = cur;
          switch (u.sessionUpdate) {
            case "agent_message_chunk": {
              const text = u.content?.type === "text" ? u.content.text ?? "" : "";
              next = appendChunk(cur, "assistant", text);
              break;
            }
            case "user_message_chunk": {
              next = appendUserChunk(cur, u.content ?? null);
              break;
            }
            case "agent_thought_chunk": {
              const text = u.content?.type === "text" ? u.content.text ?? "" : "";
              next = appendChunk(cur, "thought", text);
              break;
            }
            case "tool_call":
            case "tool_call_update": {
              next = applyToolCallEvent(cur, u);
              break;
            }
            case "plan": {
              const entries = ((msg.update as { entries?: PlanEntry[] }).entries ?? []).map(
                (e) => ({ content: e.content, priority: e.priority, status: e.status }),
              );
              next = { ...cur, plan: entries };
              break;
            }
            case "usage_update": {
              const raw = msg.update as { used?: number; size?: number };
              if (typeof raw.used === "number" && typeof raw.size === "number") {
                next = { ...cur, usage: { used: raw.used, size: raw.size } };
              } else {
                return s;
              }
              break;
            }
            case "available_commands_update": {
              return s;
            }
            default:
              return s;
          }
          return { sessions: { ...s.sessions, [msg.sessionId]: next } };
        }
        case "permission.request": {
          return {
            permissionQueue: [
              ...s.permissionQueue,
              {
                requestId: msg.requestId,
                sessionId: msg.sessionId,
                toolCall: msg.toolCall,
                options: msg.options,
              },
            ],
          };
        }
        case "user.ask": {
          return {
            userAskQueue: [
              ...s.userAskQueue,
              {
                askId: msg.askId,
                question: msg.question,
                options: msg.options,
                multiSelect: msg.multiSelect,
              },
            ],
          };
        }
        case "prompt.done": {
          const cur = s.sessions[msg.sessionId];
          if (!cur) return s;
          const done = markStreamingDone(cur);
          return {
            sessions: {
              ...s.sessions,
              [msg.sessionId]: { ...done, promptRunning: false },
            },
          };
        }
        case "error": {
          // Server-side failures (loadSession, prompt, etc.) arrive here. The
          // previous default branch dropped them silently, which made failed
          // sends look like the UI simply "did nothing". Surface them as a
          // toast and clear any stuck running flags so the user can retry.
          const sessions: Record<string, SessionState> = {};
          for (const [k, sess] of Object.entries(s.sessions)) {
            sessions[k] = sess.promptRunning
              ? { ...markStreamingDone(sess), promptRunning: false }
              : sess;
          }
          return {
            sessions,
            toasts: [
              ...s.toasts,
              { id: nextId(), level: "error", text: msg.message || "server error" },
            ],
          };
        }
        default:
          return s;
      }
    }),
}));
