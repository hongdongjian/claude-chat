import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Db } from "./db.js";

let dir: string;
let db: Db;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "db-"));
  db = new Db(path.join(dir, "t.sqlite"));
});

afterEach(async () => {
  db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const rec = (over: Partial<Parameters<Db["insert"]>[0]> = {}) => ({
  workspaceId: over.workspaceId ?? "ws1",
  sessionId: over.sessionId ?? "s1",
  cwd: over.cwd ?? "/tmp/ws1",
  title: over.title ?? "t",
  createdAt: over.createdAt ?? 1_000,
  lastActiveAt: over.lastActiveAt ?? 1_000,
});

describe("Db", () => {
  it("insert then get round-trips", () => {
    db.insert(rec());
    const got = db.getByWorkspaceId("ws1");
    expect(got).toMatchObject({
      workspaceId: "ws1",
      sessionId: "s1",
      title: "t",
      archivedAt: null,
    });
  });

  it("getByWorkspaceId returns null for unknown", () => {
    expect(db.getByWorkspaceId("none")).toBeNull();
  });

  it("rename updates title", () => {
    db.insert(rec());
    db.rename("ws1", "new title");
    expect(db.getByWorkspaceId("ws1")?.title).toBe("new title");
  });

  it("touchBySessionId updates lastActiveAt", () => {
    db.insert(rec());
    db.touchBySessionId("s1", 5_000);
    expect(db.getByWorkspaceId("ws1")?.lastActiveAt).toBe(5_000);
  });

  it("archive hides from listActive", () => {
    db.insert(rec({ workspaceId: "a", sessionId: "sa", lastActiveAt: 1 }));
    db.insert(rec({ workspaceId: "b", sessionId: "sb", lastActiveAt: 2 }));
    db.archive("a", 100);
    const active = db.listActive();
    expect(active.map((r) => r.workspaceId)).toEqual(["b"]);
  });

  it("listActive sorts by lastActiveAt desc", () => {
    db.insert(rec({ workspaceId: "a", sessionId: "sa", lastActiveAt: 1 }));
    db.insert(rec({ workspaceId: "b", sessionId: "sb", lastActiveAt: 3 }));
    db.insert(rec({ workspaceId: "c", sessionId: "sc", lastActiveAt: 2 }));
    expect(db.listActive().map((r) => r.workspaceId)).toEqual(["b", "c", "a"]);
  });
});
