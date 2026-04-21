import { randomUUID } from "node:crypto";
import { logger } from "./logger.js";

export type AskOption = { id: string; label: string; description?: string };
export type AskResult =
  | { kind: "selected"; optionId: string; text?: string }
  | { kind: "cancelled" };

type Registration = {
  connId: string;
  sessionIds: Set<string>;
  send: (msg: {
    type: "user.ask";
    askId: string;
    question: string;
    options: AskOption[];
    multiSelect: boolean;
  }) => void;
  pending: Map<string, { resolve: (r: AskResult) => void; startedAt: number }>;
};

const registry = new Map<string, Registration>();

export function registerAsker(reg: Omit<Registration, "pending">): string {
  const token = randomUUID();
  registry.set(token, { ...reg, pending: new Map() });
  return token;
}

export function unregisterAsker(token: string): void {
  const r = registry.get(token);
  if (!r) return;
  for (const p of r.pending.values()) p.resolve({ kind: "cancelled" });
  registry.delete(token);
}

export function attachSessionToToken(token: string, sessionId: string): void {
  const r = registry.get(token);
  if (r) r.sessionIds.add(sessionId);
}

export async function askUser(
  token: string,
  payload: { question: string; options: AskOption[]; multiSelect?: boolean },
): Promise<AskResult> {
  const r = registry.get(token);
  if (!r) return { kind: "cancelled" };
  const askId = randomUUID();
  const startedAt = Date.now();
  logger
    .child({ connId: r.connId, askId })
    .info(
      { optionCount: payload.options.length, multiSelect: !!payload.multiSelect },
      "ask_user start",
    );
  return new Promise<AskResult>((resolve) => {
    r.pending.set(askId, {
      resolve: (result) => {
        logger
          .child({ connId: r.connId, askId })
          .info(
            { kind: result.kind, durationMs: Date.now() - startedAt },
            "ask_user resolved",
          );
        resolve(result);
      },
      startedAt,
    });
    r.send({
      type: "user.ask",
      askId,
      question: payload.question,
      options: payload.options,
      multiSelect: !!payload.multiSelect,
    });
  });
}

export function resolveAsk(token: string, askId: string, result: AskResult): boolean {
  const r = registry.get(token);
  if (!r) return false;
  const p = r.pending.get(askId);
  if (!p) return false;
  r.pending.delete(askId);
  p.resolve(result);
  return true;
}
