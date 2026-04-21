import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceManager } from "./workspace-manager.js";

let root: string;
let mgr: WorkspaceManager;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "wsmgr-"));
  mgr = new WorkspaceManager({ root });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("WorkspaceManager", () => {
  it("create returns a path under root and creates the dir", async () => {
    const cwd = await mgr.create("abc");
    expect(cwd).toBe(path.join(root, "abc"));
    const st = await fs.stat(cwd);
    expect(st.isDirectory()).toBe(true);
  });

  it("remove deletes an existing workspace dir", async () => {
    const cwd = await mgr.create("abc");
    await mgr.remove("abc");
    await expect(fs.stat(cwd)).rejects.toBeDefined();
  });

  it("remove tolerates missing workspace", async () => {
    await expect(mgr.remove("never-created")).resolves.toBeUndefined();
  });

  it("resolvePath rejects escaping paths", () => {
    expect(() => mgr.resolvePath("abc", "../x")).toThrow(/path escapes workspace/);
  });

  it("resolvePath returns resolved within workspace", () => {
    const p = mgr.resolvePath("abc", "sub/file.txt");
    expect(p).toBe(path.join(root, "abc", "sub/file.txt"));
  });
});
