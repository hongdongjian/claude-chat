import * as os from "node:os";
import * as path from "node:path";
import Fastify from "fastify";
import websocketPlugin from "@fastify/websocket";
import { handleConnection } from "./ws-gateway.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { Db } from "./db.js";
import { logger } from "./logger.js";
import { askUser, resolveAsk } from "./ask-user-hub.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const CHAT_ROOT = path.join(os.homedir(), ".claude-chat");
const WORKSPACES_ROOT =
  process.env.CHAT_WORKSPACES_ROOT ?? path.join(CHAT_ROOT, "workspaces");
const DB_PATH = process.env.CHAT_DB_PATH ?? path.join(CHAT_ROOT, "db.sqlite");
const AUTO_GIT_INIT = process.env.CHAT_AUTO_GIT_INIT === "true";
const MAX_WRITE_BYTES = Number(process.env.CHAT_MAX_WRITE_SIZE ?? 5 * 1024 * 1024);

async function main() {
  const workspaceMgr = new WorkspaceManager({ root: WORKSPACES_ROOT, autoGitInit: AUTO_GIT_INIT });
  await workspaceMgr.ensureRoot();
  logger.info({ WORKSPACES_ROOT }, "workspace root ready");

  const db = new Db(DB_PATH);
  logger.info({ DB_PATH }, "db ready");

  const app = Fastify({ loggerInstance: logger });
  // Allow images up to ~50MB in WS prompt payloads (base64 ~= 1.33x original).
  await app.register(websocketPlugin, { options: { maxPayload: 128 * 1024 * 1024 } });

  app.get("/healthz", async () => ({ ok: true }));

  app.post("/mcp/ask-user", async (req, reply) => {
    const token = req.headers["x-ask-token"];
    if (typeof token !== "string" || !token) {
      reply.code(401);
      return { error: "missing x-ask-token" };
    }
    const body = req.body as {
      question?: string;
      options?: Array<{ id: string; label: string; description?: string }>;
      multiSelect?: boolean;
    };
    if (!body?.question) {
      reply.code(400);
      return { error: "question required" };
    }
    const result = await askUser(token, {
      question: body.question,
      options: Array.isArray(body.options) ? body.options : [],
      multiSelect: !!body.multiSelect,
    });
    return result;
  });

  // Referenced so `resolveAsk` stays imported for ws-gateway use
  void resolveAsk;

  app.get("/ws", { websocket: true }, (socket /* fastify v5: socket first */) => {
    handleConnection(socket, {
      workspaceMgr,
      workspacesRoot: WORKSPACES_ROOT,
      maxWriteBytes: MAX_WRITE_BYTES,
      db,
      serverBaseUrl: `http://${HOST}:${PORT}`,
    }).catch((err) => {
      logger.error({ err }, "handleConnection failed");
      try {
        socket.close();
      } catch {
        // ignore
      }
    });
  });

  const shutdown = () => {
    logger.info("shutting down");
    db.close();
    app.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: PORT, host: HOST });
  logger.info(`listening on ws://${HOST}:${PORT}/ws`);
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
