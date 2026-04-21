import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type WorkspaceManagerOptions = {
  root: string;
  autoGitInit?: boolean;
};

export class WorkspaceManager {
  constructor(private opts: WorkspaceManagerOptions) {}

  async ensureRoot(): Promise<void> {
    await fs.mkdir(this.opts.root, { recursive: true });
  }

  async create(workspaceId: string): Promise<string> {
    const cwd = path.join(this.opts.root, workspaceId);
    await fs.mkdir(cwd, { recursive: true });
    if (this.opts.autoGitInit) {
      try {
        await execFileAsync("git", ["init", "-q"], { cwd });
      } catch {
        // git not available or already initialized; ignore
      }
    }
    return cwd;
  }

  async remove(workspaceId: string): Promise<void> {
    const cwd = path.join(this.opts.root, workspaceId);
    const resolved = path.resolve(cwd);
    const rootResolved = path.resolve(this.opts.root);
    if (!resolved.startsWith(rootResolved + path.sep)) {
      throw new Error("refuse to remove: path escapes workspace root");
    }
    await fs.rm(resolved, { recursive: true, force: true });
  }

  resolvePath(workspaceId: string, relOrAbs: string): string {
    const cwd = path.join(this.opts.root, workspaceId);
    const resolved = path.resolve(cwd, relOrAbs);
    if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
      throw new Error(`path escapes workspace: ${relOrAbs}`);
    }
    return resolved;
  }
}
