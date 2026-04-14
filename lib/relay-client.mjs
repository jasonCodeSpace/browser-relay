import WebSocket from "ws";

const DEFAULT_HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.PORT || 47892);

export function defaultRelayUrl() {
  return `ws://${DEFAULT_HOST}:${DEFAULT_PORT}/ws?role=client`;
}

export class RelayClient {
  constructor(url = defaultRelayUrl()) {
    this.url = url;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
    this.events = [];
  }

  async connect(timeoutMs = 5000) {
    this.ws = new WebSocket(this.url);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out connecting to relay")), timeoutMs);

      this.ws.on("open", () => {
        clearTimeout(timer);
        resolve();
      });

      this.ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    this.ws.on("message", (data) => {
      const payload = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      if (payload.type === "event") {
        this.events.push(payload);
        return;
      }

      if (payload.type !== "response" || !payload.id) {
        return;
      }

      const pending = this.pending.get(payload.id);
      if (!pending) {
        return;
      }

      this.pending.delete(payload.id);
      clearTimeout(pending.timer);

      if (payload.ok) {
        pending.resolve(payload.result);
      } else {
        const error = new Error(payload.error?.message || payload.message || "relay error");
        error.code = payload.error?.code || payload.code || "RELAY_ERROR";
        pending.reject(error);
      }
    });
  }

  async call(method, params = {}, timeoutMs = 45000) {
    const id = `req-${Date.now()}-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for response: ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ type: "request", id, method, params }));
    });
  }

  close() {
    this.ws?.close();
  }
}
