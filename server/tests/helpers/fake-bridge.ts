import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpBridge } from "../../src/acp-bridge.js";

export type FakeBridge = AcpBridge & {
  emitUpdate: (n: SessionNotification) => void;
  requestPermission: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  resolveNextPrompt: (stopReason?: string) => void;
  rejectNextPrompt: (err: Error) => void;
  calls: {
    newSession: Array<{ cwd: string }>;
    loadSession: Array<{ sessionId: string; cwd: string }>;
    prompt: Array<{ sessionId: string; text: string }>;
    cancel: Array<{ sessionId: string }>;
    disposed: number;
  };
};

type PromptDeferred = {
  resolve: (v: { stopReason: string }) => void;
  reject: (e: Error) => void;
};

export function createFakeBridge(opts?: { onNewSessionId?: () => string }): FakeBridge {
  const handlers: {
    onSessionUpdate?: (n: SessionNotification) => void | Promise<void>;
    onRequestPermission?: (r: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
  } = {};

  const calls: FakeBridge["calls"] = {
    newSession: [],
    loadSession: [],
    prompt: [],
    cancel: [],
    disposed: 0,
  };

  const pendingPrompts: PromptDeferred[] = [];
  let sessionCounter = 0;
  const nextSessionId = () =>
    opts?.onNewSessionId?.() ?? `fake-sess-${++sessionCounter}`;

  const client = {
    newSession: async ({ cwd }: { cwd: string }) => {
      calls.newSession.push({ cwd });
      return { sessionId: nextSessionId() };
    },
    loadSession: async ({ sessionId, cwd }: { sessionId: string; cwd: string }) => {
      calls.loadSession.push({ sessionId, cwd });
      return {};
    },
    prompt: ({ sessionId, prompt }: { sessionId: string; prompt: Array<{ text: string }> }) => {
      const text = prompt.map((p) => p.text).join("");
      calls.prompt.push({ sessionId, text });
      return new Promise<{ stopReason: string }>((resolve, reject) => {
        pendingPrompts.push({ resolve, reject });
      });
    },
    cancel: async ({ sessionId }: { sessionId: string }) => {
      calls.cancel.push({ sessionId });
      return {};
    },
  };

  const bridge: FakeBridge = {
    // cast: we only use a subset that ws-gateway touches
    client: client as unknown as AcpBridge["client"],
    dispose: async () => {
      calls.disposed++;
    },
    emitUpdate: (n) => handlers.onSessionUpdate?.(n),
    requestPermission: (r) =>
      handlers.onRequestPermission
        ? handlers.onRequestPermission(r)
        : Promise.reject(new Error("no permission handler")),
    resolveNextPrompt: (stopReason = "end_turn") => {
      const d = pendingPrompts.shift();
      if (!d) throw new Error("no pending prompt");
      d.resolve({ stopReason });
    },
    rejectNextPrompt: (err) => {
      const d = pendingPrompts.shift();
      if (!d) throw new Error("no pending prompt");
      d.reject(err);
    },
    calls,
  };

  // Expose a way for the gateway's createAcpBridge stub to wire handlers in.
  (bridge as unknown as { _installHandlers: (h: typeof handlers) => void })._installHandlers = (
    h,
  ) => {
    Object.assign(handlers, h);
  };

  return bridge;
}
