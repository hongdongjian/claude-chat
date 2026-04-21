import pino, { type Logger, type TransportTargetOptions } from "pino";
import path from "node:path";

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const LOG_FILE = process.env.LOG_FILE;
const LOG_ROTATE_FREQUENCY = process.env.LOG_ROTATE_FREQUENCY ?? "daily";
const LOG_ROTATE_SIZE = process.env.LOG_ROTATE_SIZE ?? "20m";
const LOG_ROTATE_MAX = Number(process.env.LOG_ROTATE_MAX ?? "14");
const IS_PROD = process.env.NODE_ENV === "production";

function buildTransport() {
  const targets: TransportTargetOptions[] = [];

  // When LOG_FILE is set, route logs to the file only; otherwise keep stdout.
  // Pretty in dev, raw JSON in prod.
  if (LOG_FILE) {
    targets.push({
      target: "pino-roll",
      level: LOG_LEVEL,
      options: {
        file: path.resolve(LOG_FILE),
        frequency: LOG_ROTATE_FREQUENCY,
        size: LOG_ROTATE_SIZE,
        limit: { count: LOG_ROTATE_MAX },
        mkdir: true,
        dateFormat: "yyyy-MM-dd",
      },
    });
  } else if (IS_PROD) {
    targets.push({
      target: "pino/file",
      level: LOG_LEVEL,
      options: { destination: 1 },
    });
  } else {
    targets.push({
      target: "pino-pretty",
      level: LOG_LEVEL,
      options: { colorize: true, translateTime: "HH:MM:ss.l" },
    });
  }

  return targets.length === 1 ? targets[0] : { targets };
}

export const logger = pino({
  level: LOG_LEVEL,
  transport: buildTransport(),
});

export function withSession(
  base: Logger,
  sessionId: string,
  workspaceId?: string,
): Logger {
  return base.child(workspaceId ? { sessionId, workspaceId } : { sessionId });
}
