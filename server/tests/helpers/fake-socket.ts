import { EventEmitter } from "node:events";
import type { WsServerMessage, WsClientMessage } from "@claude-chat/shared";

export class FakeSocket extends EventEmitter {
  sent: WsServerMessage[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WsServerMessage);
  }

  close(): void {
    this.closed = true;
    this.emit("close");
  }

  // Simulate a message arriving from the client
  clientSend(msg: WsClientMessage): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  clientSendRaw(raw: string): void {
    this.emit("message", Buffer.from(raw));
  }

  /** Wait until `sent` contains a message matching predicate; timeout -> throw. */
  async waitFor(
    predicate: (m: WsServerMessage) => boolean,
    timeoutMs = 2000,
  ): Promise<WsServerMessage> {
    const existing = this.sent.find(predicate);
    if (existing) return existing;
    return new Promise<WsServerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timeout waiting; sent=${JSON.stringify(this.sent)}`));
      }, timeoutMs);
      const check = () => {
        const hit = this.sent.find(predicate);
        if (hit) {
          clearTimeout(timer);
          resolve(hit);
        } else {
          setImmediate(check);
        }
      };
      check();
    });
  }
}
