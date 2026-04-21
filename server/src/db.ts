import * as path from "node:path";
import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type PersistedSession = {
  workspaceId: string;
  sessionId: string;
  cwd: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  workspace_id   TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL UNIQUE,
  cwd            TEXT NOT NULL,
  title          TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  archived_at    INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_last_active_idx ON sessions(last_active_at DESC);
`;

export class Db {
  private sql: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.sql = new DatabaseSync(dbPath);
    this.sql.exec(SCHEMA);
  }

  insert(rec: Omit<PersistedSession, "archivedAt">): void {
    this.sql
      .prepare(
        `INSERT INTO sessions (workspace_id, session_id, cwd, title, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.workspaceId, rec.sessionId, rec.cwd, rec.title, rec.createdAt, rec.lastActiveAt);
  }

  touchBySessionId(sessionId: string, now: number): void {
    this.sql
      .prepare(`UPDATE sessions SET last_active_at = ? WHERE session_id = ?`)
      .run(now, sessionId);
  }

  updateSessionId(workspaceId: string, newSessionId: string): void {
    this.sql
      .prepare(`UPDATE sessions SET session_id = ? WHERE workspace_id = ?`)
      .run(newSessionId, workspaceId);
  }

  rename(workspaceId: string, title: string): void {
    this.sql.prepare(`UPDATE sessions SET title = ? WHERE workspace_id = ?`).run(title, workspaceId);
  }

  archive(workspaceId: string, now: number): void {
    this.sql
      .prepare(`UPDATE sessions SET archived_at = ? WHERE workspace_id = ?`)
      .run(now, workspaceId);
  }

  getByWorkspaceId(workspaceId: string): PersistedSession | null {
    const row = this.sql
      .prepare(`SELECT * FROM sessions WHERE workspace_id = ?`)
      .get(workspaceId) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : null;
  }

  listActive(): PersistedSession[] {
    const rows = this.sql
      .prepare(`SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY last_active_at DESC`)
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToSession);
  }

  close(): void {
    this.sql.close();
  }
}

function rowToSession(r: Record<string, unknown>): PersistedSession {
  return {
    workspaceId: r.workspace_id as string,
    sessionId: r.session_id as string,
    cwd: r.cwd as string,
    title: r.title as string,
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
  };
}
