import { randomUUID } from "node:crypto";
import type { WebSocket, RawData } from "ws";
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from "@agentclientprotocol/sdk";
import type {
  WsClientMessage,
  WsServerMessage,
  PermissionOption,
  ToolCallView,
} from "@claude-chat/shared";
import { createAcpBridge, type AcpBridge } from "./acp-bridge.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { FsBridge } from "./fs-bridge.js";
import { Db } from "./db.js";
import { logger, withSession } from "./logger.js";
import {
  registerAsker,
  unregisterAsker,
  attachSessionToToken,
  resolveAsk,
} from "./ask-user-hub.js";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

type SessionRecord = {
  workspaceId: string;
  cwd: string;
  title: string;
};

type PendingPermission = {
  resolve: (r: RequestPermissionResponse) => void;
  startedAt: number;
  sessionId: string;
  toolCallId: string;
};

export type GatewayDeps = {
  workspaceMgr: WorkspaceManager;
  workspacesRoot: string;
  maxWriteBytes?: number;
  db: Db;
  serverBaseUrl?: string;
};

const PERMISSION_WARN_INTERVAL_MS = 30_000;

function autoAllowEnabled(): boolean {
  const v = process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL;
  if (v === undefined) return true;
  return v !== "0" && v.toLowerCase() !== "false";
}

function askUserMcpScriptPath(): string {
  // Pure ESM .mjs sits next to this module in both dev (src/) and prod (dist/
  // after build copies it). `node <abs-path>` works without any loader, so the
  // child does not depend on tsx being resolvable from the session cwd.
  const here = path.dirname(fileURLToPath(import.meta.url));
  // In dev the module resolves to src/ws-gateway.ts; the .mjs lives next to it.
  // In prod (dist/) the build step copies ask-user-mcp.mjs into dist/.
  return path.join(here, "ask-user-mcp.mjs");
}

function buildAskUserMcpServer(token: string, baseUrl: string): {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
} {
  const script = askUserMcpScriptPath();
  return {
    type: "stdio",
    name: "ask_user",
    command: process.execPath,
    args: [script],
    env: [
      { name: "CLAUDE_CHAT_ASK_URL", value: `${baseUrl}/mcp/ask-user` },
      { name: "CLAUDE_CHAT_ASK_TOKEN", value: token },
      // The child inherits nothing by default via ACP; make sure PATH exists
      // so MCP SDK internal tooling (if any) can find basic binaries.
      { name: "PATH", value: process.env.PATH ?? "" },
      { name: "NODE_ENV", value: process.env.NODE_ENV ?? "development" },
    ],
  };
}

export async function handleConnection(socket: WebSocket, deps: GatewayDeps): Promise<void> {
  const connId = randomUUID().slice(0, 8);
  const connLog = logger.child({ connId });
  const sessions = new Map<string, SessionRecord>();
  const pendingPermissions = new Map<string, PendingPermission>();
  const permissionTimers = new Map<string, NodeJS.Timeout>();

  connLog.info("ws connected");

  const send = (msg: WsServerMessage) => {
    try {
      socket.send(JSON.stringify(msg));
    } catch (err) {
      connLog.error({ err, type: msg.type }, "failed to send ws message");
    }
  };

  const askToken = registerAsker({
    connId,
    sessionIds: new Set(),
    send: (msg) => send(msg),
  });
  const baseUrl = deps.serverBaseUrl ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  const askUserMcp = buildAskUserMcpServer(askToken, baseUrl);
  const mcpServers = [askUserMcp];
  connLog.info(
    { mcpScript: askUserMcp.args[0], mcpCommand: askUserMcp.command, baseUrl },
    "ask-user MCP configured",
  );

  const fsBridge = new FsBridge({
    resolveCwd: (sid) => sessions.get(sid)?.cwd,
    workspacesRoot: deps.workspacesRoot,
    maxWriteBytes: deps.maxWriteBytes,
  });

  const bridge: AcpBridge = await createAcpBridge({
    onSessionUpdate: (n) => {
      const kind =
        (n.update as { sessionUpdate?: string } | undefined)?.sessionUpdate ?? "unknown";
      const sLog = withSession(connLog, n.sessionId);
      const extra: Record<string, unknown> = { kind };
      if (kind === "tool_call" || kind === "tool_call_update") {
        const u = n.update as Record<string, unknown>;
        extra.toolCallId = u.toolCallId;
        extra.title = u.title;
        extra.status = u.status;
      } else if (kind === "available_commands_update") {
        const u = n.update as { availableCommands?: Array<{ name: string }> };
        extra.commandsCount = u.availableCommands?.length ?? 0;
      }
      sLog.debug(extra, "session.update");
      send({ type: "session.update", sessionId: n.sessionId, update: n.update });
    },
    onRequestPermission: (req: RequestPermissionRequest) => {
      if (autoAllowEnabled()) {
        const allow =
          req.options.find((o) => o.kind === "allow_always") ??
          req.options.find((o) => o.kind === "allow_once") ??
          req.options[0];
        withSession(connLog, req.sessionId)
          .child({ toolCallId: req.toolCall.toolCallId })
          .info(
            { optionId: allow?.optionId, kind: allow?.kind, title: req.toolCall.title },
            "permission auto-allowed (CLAUDE_CHAT_AUTO_ALLOW_ALL)",
          );
        return Promise.resolve<RequestPermissionResponse>(
          allow
            ? { outcome: { outcome: "selected", optionId: allow.optionId } }
            : { outcome: { outcome: "cancelled" } },
        );
      }
      return new Promise<RequestPermissionResponse>((resolve) => {
        const requestId = randomUUID();
        const startedAt = Date.now();
        const toolCallId = req.toolCall.toolCallId;
        pendingPermissions.set(requestId, {
          resolve,
          startedAt,
          sessionId: req.sessionId,
          toolCallId,
        });

        const pLog = withSession(connLog, req.sessionId).child({
          requestId,
          toolCallId,
        });
        pLog.info(
          {
            title: req.toolCall.title,
            kind: req.toolCall.kind,
            optionsCount: req.options.length,
          },
          "permission request",
        );

        const timer = setInterval(() => {
          const p = pendingPermissions.get(requestId);
          if (!p) return;
          pLog.warn(
            { pendingMs: Date.now() - p.startedAt },
            "permission request still pending",
          );
        }, PERMISSION_WARN_INTERVAL_MS);
        permissionTimers.set(requestId, timer);

        const options: PermissionOption[] = req.options.map((o) => ({
          optionId: o.optionId,
          name: o.name,
          kind: o.kind as PermissionOption["kind"],
        }));
        send({
          type: "permission.request",
          requestId,
          sessionId: req.sessionId,
          toolCall: toToolCallView(req.toolCall),
          options,
        });
      });
    },
    onReadTextFile: async (p) => {
      try {
        const res = await fsBridge.read(p);
        withSession(connLog, p.sessionId).debug(
          { path: p.path, bytes: res.content.length },
          "fs read ok",
        );
        return res;
      } catch (err) {
        withSession(connLog, p.sessionId).warn(
          { err, path: p.path },
          "readTextFile failed",
        );
        throw err;
      }
    },
    onWriteTextFile: async (p) => {
      try {
        const res = await fsBridge.write(p);
        withSession(connLog, p.sessionId).debug(
          { path: p.path, bytes: Buffer.byteLength(p.content, "utf8") },
          "fs write ok",
        );
        return res;
      } catch (err) {
        withSession(connLog, p.sessionId).warn(
          { err, path: p.path },
          "writeTextFile failed",
        );
        throw err;
      }
    },
  });

  try {
    const list = deps.db.listActive().map((s) => ({
      workspaceId: s.workspaceId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      lastActiveAt: s.lastActiveAt,
    }));
    connLog.info({ count: list.length }, "push sessions.list");
    send({ type: "sessions.list", sessions: list });
  } catch (err) {
    connLog.error({ err }, "failed to list persisted sessions");
  }

  socket.on("message", async (raw: RawData) => {
    let msg: WsClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      connLog.warn({ size: raw.toString().length }, "invalid json from ws");
      send({ type: "error", message: "invalid json" });
      return;
    }

    const msgLog = connLog.child({ msgType: msg.type });
    msgLog.debug("ws msg in");

    try {
      switch (msg.type) {
        case "session.new": {
          const workspaceId = randomUUID();
          const cwd = await deps.workspaceMgr.create(workspaceId);
          let res;
          try {
            res = await bridge.client.newSession({ cwd, mcpServers });
          } catch (err) {
            msgLog.error(
              { err, workspaceId, cwd, mcpScript: askUserMcp.args[0] },
              "newSession failed (likely MCP spawn)",
            );
            send({ type: "error", message: `newSession failed: ${String((err as Error)?.message ?? err)}` });
            break;
          }
          const title = msg.title ?? `Session ${workspaceId.slice(0, 8)}`;
          const now = Date.now();
          sessions.set(res.sessionId, { workspaceId, cwd, title });
          attachSessionToToken(askToken, res.sessionId);
          deps.db.insert({
            workspaceId,
            sessionId: res.sessionId,
            cwd,
            title,
            createdAt: now,
            lastActiveAt: now,
          });
          msgLog.info({ sessionId: res.sessionId, workspaceId, title }, "session created");
          send({ type: "session.created", sessionId: res.sessionId, workspaceId, cwd, title });
          break;
        }
        case "session.load": {
          const rec = deps.db.getByWorkspaceId(msg.workspaceId);
          if (!rec) {
            msgLog.warn({ workspaceId: msg.workspaceId }, "session.load unknown workspace");
            send({ type: "error", message: `unknown workspace: ${msg.workspaceId}` });
            break;
          }
          let effectiveSessionId = rec.sessionId;
          let previousSessionId: string | undefined;
          if (!sessions.has(rec.sessionId)) {
            let loaded = false;
            try {
              await bridge.client.loadSession({
                sessionId: rec.sessionId,
                cwd: rec.cwd,
                mcpServers,
              });
              loaded = true;
            } catch (err) {
              // Common failure: Claude CLI never persisted the session (e.g.
              // the user created it and refreshed before the first prompt).
              // Fall back to a fresh ACP session under the same cwd so the
              // workspace stays usable; migrate the DB's session_id to match.
              msgLog.warn(
                { err, workspaceId: msg.workspaceId, sessionId: rec.sessionId, cwd: rec.cwd },
                "loadSession failed; attempting newSession fallback",
              );
              try {
                const fresh = await bridge.client.newSession({ cwd: rec.cwd, mcpServers });
                previousSessionId = rec.sessionId;
                effectiveSessionId = fresh.sessionId;
                deps.db.updateSessionId(rec.workspaceId, fresh.sessionId);
                loaded = true;
                msgLog.info(
                  {
                    workspaceId: msg.workspaceId,
                    oldSessionId: previousSessionId,
                    newSessionId: effectiveSessionId,
                  },
                  "session rebound to fresh ACP session",
                );
              } catch (err2) {
                msgLog.error(
                  { err: err2, workspaceId: msg.workspaceId, cwd: rec.cwd },
                  "newSession fallback failed",
                );
                send({
                  type: "error",
                  message: `loadSession failed: ${String((err as Error)?.message ?? err)}`,
                });
              }
            }
            if (loaded) {
              sessions.set(effectiveSessionId, {
                workspaceId: rec.workspaceId,
                cwd: rec.cwd,
                title: rec.title,
              });
            }
          }
          attachSessionToToken(askToken, effectiveSessionId);
          msgLog.info(
            { sessionId: effectiveSessionId, workspaceId: rec.workspaceId, previousSessionId },
            "session loaded",
          );
          send({
            type: "session.loaded",
            sessionId: effectiveSessionId,
            workspaceId: rec.workspaceId,
            cwd: rec.cwd,
            title: rec.title,
            ...(previousSessionId ? { previousSessionId } : {}),
          });
          break;
        }
        case "session.rename": {
          deps.db.rename(msg.workspaceId, msg.title);
          const rec = sessions.get(findSessionIdByWorkspaceId(sessions, msg.workspaceId) ?? "");
          if (rec) rec.title = msg.title;
          msgLog.info({ workspaceId: msg.workspaceId, title: msg.title }, "session renamed");
          send({ type: "session.renamed", workspaceId: msg.workspaceId, title: msg.title });
          break;
        }
        case "session.delete": {
          deps.db.archive(msg.workspaceId, Date.now());
          if (msg.removeFiles) {
            try {
              await deps.workspaceMgr.remove(msg.workspaceId);
            } catch (err) {
              msgLog.warn({ err, workspaceId: msg.workspaceId }, "remove workspace failed");
            }
          }
          const sid = findSessionIdByWorkspaceId(sessions, msg.workspaceId);
          if (sid) sessions.delete(sid);
          msgLog.info(
            { workspaceId: msg.workspaceId, removeFiles: !!msg.removeFiles },
            "session deleted",
          );
          send({ type: "session.deleted", workspaceId: msg.workspaceId });
          break;
        }
        case "session.prompt": {
          if (!sessions.has(msg.sessionId)) {
            msgLog.warn({ sessionId: msg.sessionId }, "prompt for unknown session");
            send({ type: "error", message: `unknown session: ${msg.sessionId}` });
            break;
          }
          deps.db.touchBySessionId(msg.sessionId, Date.now());
          const startedAt = Date.now();
          const sLog = withSession(msgLog, msg.sessionId);
          const images = Array.isArray(msg.images) ? msg.images : [];
          sLog.info(
            { textLen: msg.text.length, imageCount: images.length },
            "prompt start",
          );
          const promptBlocks: Array<
            | { type: "text"; text: string }
            | { type: "image"; data: string; mimeType: string }
          > = [];
          if (msg.text && msg.text.length > 0) {
            promptBlocks.push({ type: "text", text: msg.text });
          }
          for (const img of images) {
            if (!img || typeof img.data !== "string" || typeof img.mimeType !== "string") continue;
            promptBlocks.push({ type: "image", data: img.data, mimeType: img.mimeType });
          }
          if (promptBlocks.length === 0) {
            send({ type: "error", message: "prompt must contain text or images" });
            break;
          }
          bridge.client
            .prompt({ sessionId: msg.sessionId, prompt: promptBlocks })
            .then((res) => {
              sLog.info(
                { stopReason: res.stopReason, durationMs: Date.now() - startedAt },
                "prompt done",
              );
              send({ type: "prompt.done", sessionId: msg.sessionId, stopReason: res.stopReason });
            })
            .catch((err) => {
              sLog.error(
                { err, durationMs: Date.now() - startedAt },
                "prompt failed",
              );
              send({ type: "error", message: `prompt failed: ${String(err?.message ?? err)}` });
              // Always emit prompt.done so the client clears its running state,
              // even on rejection (cancel, bridge teardown, agent crash, ...).
              send({ type: "prompt.done", sessionId: msg.sessionId, stopReason: "error" });
            });
          break;
        }
        case "session.cancel": {
          withSession(msgLog, msg.sessionId).info("session cancel");
          await bridge.client.cancel({ sessionId: msg.sessionId });
          break;
        }
        case "session.idle": {
          // UI reports the session has been backgrounded long enough to drop.
          // We can't ask ACP to unload (no such RPC), but we can forget it
          // locally so the next interaction re-calls loadSession cleanly.
          if (sessions.has(msg.sessionId)) {
            sessions.delete(msg.sessionId);
            withSession(msgLog, msg.sessionId).info("session idled (dropped from memory)");
          } else {
            withSession(msgLog, msg.sessionId).debug("session.idle for unknown session");
          }
          break;
        }
        case "permission.reply": {
          const pending = pendingPermissions.get(msg.requestId);
          if (!pending) {
            msgLog.warn({ requestId: msg.requestId }, "permission.reply for unknown requestId");
            break;
          }
          pendingPermissions.delete(msg.requestId);
          const timer = permissionTimers.get(msg.requestId);
          if (timer) {
            clearInterval(timer);
            permissionTimers.delete(msg.requestId);
          }
          const durationMs = Date.now() - pending.startedAt;
          const outcome = msg.outcome === "cancelled" ? "cancelled" : "selected";
          withSession(msgLog, pending.sessionId)
            .child({ requestId: msg.requestId, toolCallId: pending.toolCallId })
            .info({ outcome, optionId: msg.optionId, durationMs }, "permission reply");
          if (msg.outcome === "cancelled") {
            pending.resolve({ outcome: { outcome: "cancelled" } });
          } else {
            pending.resolve({ outcome: { outcome: "selected", optionId: msg.optionId } });
          }
          break;
        }
        case "user.ask.reply": {
          const ok = resolveAsk(
            askToken,
            msg.askId,
            msg.outcome === "cancelled"
              ? { kind: "cancelled" }
              : { kind: "selected", optionId: msg.optionId ?? "", text: msg.text },
          );
          if (!ok) msgLog.warn({ askId: msg.askId }, "user.ask.reply for unknown askId");
          else msgLog.info({ askId: msg.askId, outcome: msg.outcome }, "user.ask.reply");
          break;
        }
      }
    } catch (err) {
      connLog.error({ err, msgType: msg.type }, "ws handler error");
      send({ type: "error", message: String((err as Error)?.message ?? err) });
    }
  });

  socket.on("close", async () => {
    connLog.info(
      { pendingPermissions: pendingPermissions.size, sessions: sessions.size },
      "ws disconnected, cancelling sessions and disposing bridge",
    );
    for (const sid of sessions.keys()) {
      try {
        await bridge.client.cancel({ sessionId: sid });
        withSession(connLog, sid).info("session cancelled due to ws close");
      } catch (err) {
        withSession(connLog, sid).warn({ err }, "session cancel on ws close failed");
      }
    }
    for (const [requestId, p] of pendingPermissions.entries()) {
      connLog.warn(
        {
          requestId,
          sessionId: p.sessionId,
          toolCallId: p.toolCallId,
          pendingMs: Date.now() - p.startedAt,
        },
        "permission cancelled due to ws close",
      );
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
    pendingPermissions.clear();
    for (const timer of permissionTimers.values()) clearInterval(timer);
    permissionTimers.clear();
    unregisterAsker(askToken);
    await bridge.dispose();
  });
}

function toToolCallView(tc: RequestPermissionRequest["toolCall"]): ToolCallView {
  return {
    toolCallId: tc.toolCallId,
    title: tc.title ?? undefined,
    kind: (tc.kind ?? undefined) as ToolCallView["kind"],
    status: (tc.status ?? undefined) as ToolCallView["status"],
    rawInput: tc.rawInput,
    locations: tc.locations?.map((l) => ({ path: l.path, line: l.line ?? undefined })) ?? undefined,
  };
}

function findSessionIdByWorkspaceId(
  sessions: Map<string, SessionRecord>,
  workspaceId: string,
): string | undefined {
  for (const [sid, rec] of sessions) if (rec.workspaceId === workspaceId) return sid;
  return undefined;
}
