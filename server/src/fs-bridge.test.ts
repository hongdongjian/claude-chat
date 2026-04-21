import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FsBridge } from "./fs-bridge.js";

let root: string;
let sessionCwd: string;
const SID = "sess-1";

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "fsbridge-"));
  sessionCwd = path.join(root, "ws-a");
  await fs.mkdir(sessionCwd, { recursive: true });
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function makeBridge(maxWriteBytes?: number) {
  return new FsBridge({
    resolveCwd: (sid) => (sid === SID ? sessionCwd : undefined),
    workspacesRoot: root,
    maxWriteBytes,
  });
}

describe("FsBridge.read", () => {
  it("reads existing file", async () => {
    await fs.writeFile(path.join(sessionCwd, "a.txt"), "hello\nworld\n");
    const b = makeBridge();
    const res = await b.read({ sessionId: SID, path: "a.txt" });
    expect(res.content).toBe("hello\nworld\n");
  });

  it("slices by line + limit (1-based line)", async () => {
    await fs.writeFile(path.join(sessionCwd, "a.txt"), "l1\nl2\nl3\nl4\n");
    const b = makeBridge();
    const res = await b.read({ sessionId: SID, path: "a.txt", line: 2, limit: 2 });
    expect(res.content).toBe("l2\nl3");
  });

  it("rejects unknown session", async () => {
    const b = makeBridge();
    await expect(b.read({ sessionId: "nope", path: "a.txt" })).rejects.toThrow(
      /unknown session/,
    );
  });

  it("rejects path escaping workspace via relative ..", async () => {
    await fs.writeFile(path.join(root, "secret.txt"), "s");
    const b = makeBridge();
    await expect(
      b.read({ sessionId: SID, path: "../secret.txt" }),
    ).rejects.toThrow(/path escapes session workspace/);
  });

  it("rejects absolute path outside cwd", async () => {
    const b = makeBridge();
    await expect(
      b.read({ sessionId: SID, path: "/etc/hosts" }),
    ).rejects.toThrow(/path escapes session workspace/);
  });

  it("propagates ENOENT", async () => {
    const b = makeBridge();
    await expect(b.read({ sessionId: SID, path: "missing.txt" })).rejects.toThrow();
  });
});

describe("FsBridge.write", () => {
  it("writes to nested path (mkdir -p)", async () => {
    const b = makeBridge();
    await b.write({ sessionId: SID, path: "sub/x.txt", content: "hi" });
    const back = await fs.readFile(path.join(sessionCwd, "sub/x.txt"), "utf8");
    expect(back).toBe("hi");
  });

  it("rejects when content exceeds maxWriteBytes", async () => {
    const b = makeBridge(4);
    await expect(
      b.write({ sessionId: SID, path: "x.txt", content: "toolong" }),
    ).rejects.toThrow(/exceeds max size/);
  });

  it("rejects write escaping workspace", async () => {
    const b = makeBridge();
    await expect(
      b.write({ sessionId: SID, path: "../pwned.txt", content: "x" }),
    ).rejects.toThrow(/path escapes session workspace/);
  });

  it("rejects unknown session", async () => {
    const b = makeBridge();
    await expect(
      b.write({ sessionId: "nope", path: "x.txt", content: "x" }),
    ).rejects.toThrow(/unknown session/);
  });
});
