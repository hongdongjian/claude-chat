import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

export type FsBridgeOptions = {
  resolveCwd: (sessionId: string) => string | undefined;
  workspacesRoot: string;
  maxWriteBytes?: number;
};

const DEFAULT_MAX_WRITE_BYTES = 5 * 1024 * 1024;

export class FsBridge {
  constructor(private opts: FsBridgeOptions) {}

  async read(req: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const resolved = this.resolveWithinSandbox(req.sessionId, req.path);
    const raw = await fs.readFile(resolved, "utf8");
    const content = sliceLines(raw, req.line ?? null, req.limit ?? null);
    return { content };
  }

  async write(req: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    const resolved = this.resolveWithinSandbox(req.sessionId, req.path);
    const max = this.opts.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
    const size = Buffer.byteLength(req.content, "utf8");
    if (size > max) {
      throw new Error(`write exceeds max size: ${size} > ${max} bytes`);
    }
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, req.content, "utf8");
    return {};
  }

  private resolveWithinSandbox(sessionId: string, filePath: string): string {
    const cwd = this.opts.resolveCwd(sessionId);
    if (!cwd) throw new Error(`unknown session: ${sessionId}`);

    const cwdResolved = path.resolve(cwd);
    const rootResolved = path.resolve(this.opts.workspacesRoot);
    if (cwdResolved !== rootResolved && !cwdResolved.startsWith(rootResolved + path.sep)) {
      throw new Error("session cwd escapes workspace root");
    }

    const target = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwdResolved, filePath);

    if (target !== cwdResolved && !target.startsWith(cwdResolved + path.sep)) {
      throw new Error(`path escapes session workspace: ${filePath}`);
    }
    return target;
  }
}

function sliceLines(content: string, line: number | null, limit: number | null): string {
  if (line == null && limit == null) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit != null ? start + limit : lines.length;
  return lines.slice(start, end).join("\n");
}
