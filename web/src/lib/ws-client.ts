import type { WsClientMessage, WsServerMessage } from "@claude-chat/shared";

export type WsClientOptions = {
  url: string;
  onMessage: (msg: WsServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

export class WsClient {
  private ws: WebSocket | null = null;
  private reconnectDelay = 500;
  private disposed = false;

  constructor(private opts: WsClientOptions) {
    this.connect();
  }

  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectDelay = 500;
      this.opts.onOpen?.();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as WsServerMessage;
        this.opts.onMessage(msg);
      } catch {
        // ignore malformed
      }
    };
    ws.onclose = () => {
      this.opts.onClose?.();
      if (this.disposed) return;
      setTimeout(() => this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  send(msg: WsClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  dispose() {
    this.disposed = true;
    this.ws?.close();
  }
}
