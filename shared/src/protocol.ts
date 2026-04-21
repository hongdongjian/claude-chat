// WS message types shared between server and web.
// Server-pushed `session.update` carries the raw ACP SessionUpdate untouched
// so the web renderer uses the same field names as the spec.

export type WsClientMessage =
  | { type: "session.new"; title?: string }
  | { type: "session.load"; workspaceId: string }
  | { type: "session.rename"; workspaceId: string; title: string }
  | { type: "session.delete"; workspaceId: string; removeFiles?: boolean }
  | {
      type: "session.prompt";
      sessionId: string;
      text: string;
      images?: Array<{ data: string; mimeType: string }>;
    }
  | { type: "session.cancel"; sessionId: string }
  | { type: "session.idle"; sessionId: string }
  | { type: "permission.reply"; requestId: string; optionId: string; outcome?: "selected" | "cancelled" }
  | {
      type: "user.ask.reply";
      askId: string;
      outcome: "selected" | "cancelled";
      optionId?: string;
      text?: string;
    };

export type WsServerMessage =
  | {
      type: "sessions.list";
      sessions: Array<{
        workspaceId: string;
        sessionId: string;
        cwd: string;
        title: string;
        lastActiveAt: number;
      }>;
    }
  | { type: "session.created"; sessionId: string; workspaceId: string; cwd: string; title: string }
  | {
      type: "session.loaded";
      sessionId: string;
      workspaceId: string;
      cwd: string;
      title: string;
      // Set when the original ACP session was no longer resumable and we
      // rebound this workspace to a fresh sessionId. Clients key sessions by
      // sessionId, so they must migrate state from the previous id.
      previousSessionId?: string;
    }
  | { type: "session.renamed"; workspaceId: string; title: string }
  | { type: "session.deleted"; workspaceId: string }
  | { type: "session.update"; sessionId: string; update: unknown }
  | {
      type: "permission.request";
      requestId: string;
      sessionId: string;
      toolCall: ToolCallView;
      options: PermissionOption[];
    }
  | { type: "prompt.done"; sessionId: string; stopReason: string }
  | {
      type: "user.ask";
      askId: string;
      question: string;
      options: Array<{ id: string; label: string; description?: string }>;
      multiSelect: boolean;
    }
  | { type: "error"; message: string; code?: string };

export type PermissionOption = {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

// Slimmed-down tool call shape used for permission prompts.
// (The full ACP ToolCall/ToolCallUpdate type still flows through `session.update`.)
export type ToolCallView = {
  toolCallId: string;
  title?: string;
  kind?: "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
  status?: "pending" | "in_progress" | "completed" | "failed";
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number }>;
};
