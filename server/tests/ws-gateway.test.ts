import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFakeBridge, type FakeBridge } from "../tests/helpers/fake-bridge.js";
import { FakeSocket } from "../tests/helpers/fake-socket.js";

// Hoisted mock of acp-bridge: the gateway calls createAcpBridge(handlers)
// and receives our FakeBridge; we capture handlers for later triggering.
let currentFake: FakeBridge | null = null;
vi.mock("../src/acp-bridge.js", () => ({
  createAcpBridge: async (handlers: unknown) => {
    const fake = createFakeBridge();
    (fake as unknown as { _installHandlers: (h: unknown) => void })._installHandlers(handlers);
    currentFake = fake;
    return fake;
  },
}));

// Dynamic import AFTER mock is registered.
const { handleConnection } = await import("../src/ws-gateway.js");
const { WorkspaceManager } = await import("../src/workspace-manager.js");
const { Db } = await import("../src/db.js");

let tmpRoot: string;
let wsRoot: string;
let dbPath: string;
let workspaceMgr: InstanceType<typeof WorkspaceManager>;
let db: InstanceType<typeof Db>;
let socket: FakeSocket;

beforeEach(async () => {
  process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL = "0";
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wsgw-"));
  wsRoot = path.join(tmpRoot, "workspaces");
  dbPath = path.join(tmpRoot, "t.sqlite");
  await fs.mkdir(wsRoot, { recursive: true });
  workspaceMgr = new WorkspaceManager({ root: wsRoot });
  db = new Db(dbPath);
  socket = new FakeSocket();
  currentFake = null;
  await handleConnection(socket as unknown as import("ws").WebSocket, {
    workspaceMgr,
    workspacesRoot: wsRoot,
    db,
  });
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

const fake = (): FakeBridge => {
  if (!currentFake) throw new Error("bridge not set up");
  return currentFake;
};

describe("ws-gateway", () => {
  it("pushes sessions.list on connect", async () => {
    const msg = await socket.waitFor((m) => m.type === "sessions.list");
    expect(msg).toMatchObject({ type: "sessions.list", sessions: [] });
  });

  it("session.new → session.created and db row", async () => {
    socket.clientSend({ type: "session.new", title: "t1" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    expect(created).toMatchObject({ type: "session.created", title: "t1" });
    const sessionId = (created as { sessionId: string }).sessionId;
    const workspaceId = (created as { workspaceId: string }).workspaceId;
    expect(fake().calls.newSession).toHaveLength(1);
    expect(db.getByWorkspaceId(workspaceId)?.sessionId).toBe(sessionId);
  });

  it("session.prompt unknown session → error", async () => {
    socket.clientSend({ type: "session.prompt", sessionId: "no", text: "hi" });
    const err = await socket.waitFor((m) => m.type === "error");
    expect((err as { message: string }).message).toMatch(/unknown session/);
  });

  it("full prompt flow: update chunks → prompt.done with stopReason", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const sessionId = (created as { sessionId: string }).sessionId;

    socket.clientSend({ type: "session.prompt", sessionId, text: "hello" });
    // Wait until bridge received prompt
    await vi.waitFor(() => expect(fake().calls.prompt).toHaveLength(1));

    // Emit two agent chunks
    fake().emitUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "part1 " },
      },
    } as never);
    fake().emitUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "part2" },
      },
    } as never);
    const updates = socket.sent.filter((m) => m.type === "session.update");
    expect(updates).toHaveLength(2);

    fake().resolveNextPrompt("end_turn");
    const done = await socket.waitFor((m) => m.type === "prompt.done");
    expect(done).toMatchObject({ sessionId, stopReason: "end_turn" });
  });

  it("prompt rejection → error message to client", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const sessionId = (created as { sessionId: string }).sessionId;
    socket.clientSend({ type: "session.prompt", sessionId, text: "x" });
    await vi.waitFor(() => expect(fake().calls.prompt).toHaveLength(1));
    fake().rejectNextPrompt(new Error("boom"));
    const err = await socket.waitFor((m) => m.type === "error");
    expect((err as { message: string }).message).toMatch(/prompt failed.*boom/);
  });

  it("session.cancel forwards to bridge", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const sessionId = (created as { sessionId: string }).sessionId;
    socket.clientSend({ type: "session.cancel", sessionId });
    await vi.waitFor(() => expect(fake().calls.cancel).toEqual([{ sessionId }]));
  });

  it("permission request → client receives; reply resolves with selected", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const sessionId = (created as { sessionId: string }).sessionId;

    const permPromise = fake().requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "tc-1",
        title: "run atlasctl",
        kind: "execute",
        status: "pending",
        rawInput: { cmd: "atlasctl" },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    } as never);

    const perm = await socket.waitFor((m) => m.type === "permission.request");
    const requestId = (perm as { requestId: string }).requestId;
    socket.clientSend({ type: "permission.reply", requestId, optionId: "allow" });
    const res = await permPromise;
    expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
  });

  it("permission pending when socket closes → resolves cancelled", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const sessionId = (created as { sessionId: string }).sessionId;

    const permPromise = fake().requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "tc-2",
        title: "write file",
        kind: "edit",
        status: "pending",
        rawInput: {},
      },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    } as never);
    await socket.waitFor((m) => m.type === "permission.request");
    socket.close();
    const res = await permPromise;
    expect(res).toEqual({ outcome: { outcome: "cancelled" } });
    expect(fake().calls.disposed).toBe(1);
  });

  it("auto-allow: CLAUDE_CHAT_AUTO_ALLOW_ALL=1 bypasses UI and selects allow", async () => {
    const prev = process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL;
    process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL = "1";
    try {
      const socket2 = new FakeSocket();
      currentFake = null;
      await handleConnection(socket2 as unknown as import("ws").WebSocket, {
        workspaceMgr,
        workspacesRoot: wsRoot,
        db,
      });
      socket2.clientSend({ type: "session.new" });
      const created = await socket2.waitFor((m) => m.type === "session.created");
      const sessionId = (created as { sessionId: string }).sessionId;
      const res = await fake().requestPermission({
        sessionId,
        toolCall: {
          toolCallId: "tc-auto",
          title: "dangerous",
          kind: "execute",
          status: "pending",
          rawInput: {},
        },
        options: [
          { optionId: "allow1", name: "Allow once", kind: "allow_once" },
          { optionId: "allowA", name: "Allow always", kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      } as never);
      expect(res).toEqual({ outcome: { outcome: "selected", optionId: "allowA" } });
      expect(socket2.sent.find((m) => m.type === "permission.request")).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL;
      else process.env.CLAUDE_CHAT_AUTO_ALLOW_ALL = prev;
    }
  });

  it("invalid JSON → error", async () => {
    socket.clientSendRaw("{not json");
    const err = await socket.waitFor((m) => m.type === "error");
    expect((err as { message: string }).message).toBe("invalid json");
  });

  it("session.rename updates db and notifies", async () => {
    socket.clientSend({ type: "session.new", title: "old" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const workspaceId = (created as { workspaceId: string }).workspaceId;
    socket.clientSend({ type: "session.rename", workspaceId, title: "new" });
    const renamed = await socket.waitFor((m) => m.type === "session.renamed");
    expect(renamed).toMatchObject({ workspaceId, title: "new" });
    expect(db.getByWorkspaceId(workspaceId)?.title).toBe("new");
  });

  it("session.delete archives in db (no file removal by default)", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const workspaceId = (created as { workspaceId: string }).workspaceId;
    socket.clientSend({ type: "session.delete", workspaceId });
    await socket.waitFor((m) => m.type === "session.deleted");
    expect(db.listActive().map((r) => r.workspaceId)).not.toContain(workspaceId);
    // files still there
    await expect(fs.stat(path.join(wsRoot, workspaceId))).resolves.toBeDefined();
  });

  it("session.delete with removeFiles deletes directory", async () => {
    socket.clientSend({ type: "session.new" });
    const created = await socket.waitFor((m) => m.type === "session.created");
    const workspaceId = (created as { workspaceId: string }).workspaceId;
    socket.clientSend({ type: "session.delete", workspaceId, removeFiles: true });
    await socket.waitFor((m) => m.type === "session.deleted");
    await expect(fs.stat(path.join(wsRoot, workspaceId))).rejects.toBeDefined();
  });

  it("session.load for unknown workspace → error", async () => {
    socket.clientSend({ type: "session.load", workspaceId: "nope" });
    const err = await socket.waitFor(
      (m) => m.type === "error" && /unknown workspace/.test((m as { message: string }).message),
    );
    expect(err).toBeDefined();
  });
});
