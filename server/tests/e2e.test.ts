import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import websocketPlugin from "@fastify/websocket";
import WebSocket from "ws";
import type { WsClientMessage, WsServerMessage } from "@claude-chat/shared";
import { handleConnection } from "../src/ws-gateway.js";
import { WorkspaceManager } from "../src/workspace-manager.js";
import { Db } from "../src/db.js";

// Real end-to-end test. Hits the actual ACP agent stack which in turn calls
// the Anthropic-compatible endpoint defined by ANTHROPIC_BASE_URL / token.
// The local proxy is expected to route to whatever ANTHROPIC_MODEL points to.

let app: FastifyInstance;
let port: number;
let tmpRoot: string;
const envBackup: Record<string, string | undefined> = {};

function forceModel(name: string) {
  for (const key of [
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
  ]) {
    envBackup[key] = process.env[key];
    process.env[key] = name;
  }
}

function restoreEnv() {
  for (const [k, v] of Object.entries(envBackup)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

async function send(ws: WebSocket, msg: WsClientMessage): Promise<void> {
  if (ws.readyState !== ws.OPEN) {
    await new Promise<void>((r) => ws.once("open", () => r()));
  }
  ws.send(JSON.stringify(msg));
}

function waitFor(
  ws: WebSocket,
  predicate: (m: WsServerMessage) => boolean,
  timeoutMs = 60_000,
): Promise<WsServerMessage> {
  return new Promise((resolve, reject) => {
    const buffered: WsServerMessage[] = [];
    const onMsg = (data: WebSocket.RawData) => {
      try {
        const m = JSON.parse(data.toString()) as WsServerMessage;
        buffered.push(m);
        if (predicate(m)) {
          ws.off("message", onMsg);
          clearTimeout(timer);
          resolve(m);
        }
      } catch {
        // ignore parse errors
      }
    };
    const timer = setTimeout(() => {
      ws.off("message", onMsg);
      reject(
        new Error(
          `e2e waitFor timeout; last ${buffered.length} msgs: ${JSON.stringify(
            buffered.slice(-5),
          )}`,
        ),
      );
    }, timeoutMs);
    ws.on("message", onMsg);
  });
}

beforeAll(async () => {
  forceModel("gpt-5-mini");
  // e2e uses default auto-allow (CLAUDE_CHAT_AUTO_ALLOW_ALL unset or =1);
  // the atlasctl test explicitly toggles it to "0" inside the test to exercise
  // the manual permission.request path.
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "e2e-"));
  const workspacesRoot = path.join(tmpRoot, "ws");
  const dbPath = path.join(tmpRoot, "db.sqlite");
  await fs.mkdir(workspacesRoot, { recursive: true });
  const workspaceMgr = new WorkspaceManager({ root: workspacesRoot });
  await workspaceMgr.ensureRoot();
  const db = new Db(dbPath);

  app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  app.get("/ws", { websocket: true }, (socket) => {
    handleConnection(socket, { workspaceMgr, workspacesRoot, db }).catch(() => {
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  port = addr.port;
}, 30_000);

afterAll(async () => {
  await app?.close();
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
  restoreEnv();
});

function connect(): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/ws`);
}

describe("e2e (real ACP + Anthropic endpoint)", () => {
  it("handshake → sessions.list is pushed", async () => {
    const ws = connect();
    const list = await waitFor(ws, (m) => m.type === "sessions.list", 10_000);
    expect(list).toMatchObject({ type: "sessions.list" });
    ws.close();
  });

  it("session.new → session.created", async () => {
    const ws = connect();
    await waitFor(ws, (m) => m.type === "sessions.list", 10_000);
    await send(ws, { type: "session.new", title: "e2e" });
    const created = await waitFor(ws, (m) => m.type === "session.created", 30_000);
    expect(created).toMatchObject({ type: "session.created", title: "e2e" });
    ws.close();
  });

  it("short prompt → at least one session.update + prompt.done", async () => {
    const ws = connect();
    await waitFor(ws, (m) => m.type === "sessions.list", 10_000);
    await send(ws, { type: "session.new" });
    const created = (await waitFor(
      ws,
      (m) => m.type === "session.created",
      30_000,
    )) as { sessionId: string };
    await send(ws, {
      type: "session.prompt",
      sessionId: created.sessionId,
      text: "请只回复两个字：收到",
    });
    // wait for the first update
    await waitFor(ws, (m) => m.type === "session.update", 60_000);
    const done = (await waitFor(
      ws,
      (m) => m.type === "prompt.done",
      60_000,
    )) as { stopReason: string };
    expect(done.stopReason).toBeTruthy();
    ws.close();
  }, 120_000);

  it("/atlasctl-style prompt: permission requested, auto-allow, then prompt.done", async () => {
    const prevAuto = process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL;
    process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL = "0";
    const ws = connect();
    await waitFor(ws, (m) => m.type === "sessions.list", 10_000);
    await send(ws, { type: "session.new" });
    const created = (await waitFor(
      ws,
      (m) => m.type === "session.created",
      30_000,
    )) as { sessionId: string };

    // Auto-reply to any permission request with allow_once — mirrors what a
    // human clicking "Allow" in the UI would do. Without this the prompt hangs
    // forever, which was the real "conversation interruption" symptom.
    let permissionSeen = false;
    ws.on("message", (data) => {
      try {
        const m = JSON.parse(data.toString()) as WsServerMessage;
        if (m.type === "permission.request") {
          permissionSeen = true;
          const allow = m.options.find((o) => o.kind === "allow_once") ?? m.options[0];
          ws.send(
            JSON.stringify({
              type: "permission.reply",
              requestId: m.requestId,
              optionId: allow.optionId,
              outcome: "selected",
            }),
          );
        }
      } catch {
        // ignore
      }
    });

    await send(ws, {
      type: "session.prompt",
      sessionId: created.sessionId,
      text: "/atlasctl 分析pg-7d3eg1o6ox有没问题",
    });
    const done = (await waitFor(
      ws,
      (m) => m.type === "prompt.done",
      180_000,
    )) as { stopReason: string };
    expect(done.stopReason).toBeTruthy();
    // Two possible root causes for the "interruption" symptom depending on the
    // backing model:
    //   1. Capable model (e.g. Claude) decides to call Bash → permission.request
    //      is sent → UI doesn't answer → prompt hangs. (permissionSeen=true path)
    //   2. Weaker model (e.g. gpt-5-mini) hallucinates an async promise
    //      ("I will report back") and ends with end_turn without calling tools.
    //      (permissionSeen=false, stopReason=end_turn)
    // Either way the gateway delivers prompt.done; the UI-visible "interruption"
    // is explained by whichever path we took. Log it so regressions are legible.
    // eslint-disable-next-line no-console
    console.log(
      `[e2e/atlasctl] permissionSeen=${permissionSeen} stopReason=${done.stopReason}`,
    );
    if (prevAuto === undefined) delete process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL;
    else process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL = prevAuto;
    ws.close();
  }, 240_000);

  it("cancel then reuse session works", async () => {
    const ws = connect();
    await waitFor(ws, (m) => m.type === "sessions.list", 10_000);
    await send(ws, { type: "session.new" });
    const created = (await waitFor(
      ws,
      (m) => m.type === "session.created",
      30_000,
    )) as { sessionId: string };
    await send(ws, {
      type: "session.prompt",
      sessionId: created.sessionId,
      text: "请用 20 字简述 claude-chat 项目。",
    });
    // Cancel shortly after
    setTimeout(() => {
      void send(ws, { type: "session.cancel", sessionId: created.sessionId });
    }, 300);
    // Either cancelled stop-reason or end_turn is acceptable
    const done = (await waitFor(
      ws,
      (m) => m.type === "prompt.done",
      60_000,
    )) as { stopReason: string };
    expect(done.stopReason).toBeTruthy();

    // Reuse: send another prompt
    await send(ws, {
      type: "session.prompt",
      sessionId: created.sessionId,
      text: "回复一个字：好",
    });
    const done2 = (await waitFor(
      ws,
      (m) => m.type === "prompt.done",
      60_000,
    )) as { stopReason: string };
    expect(done2.stopReason).toBeTruthy();
    ws.close();
  }, 180_000);
});
