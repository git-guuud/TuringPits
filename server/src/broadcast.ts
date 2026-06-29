/**
 * WebSocket hub. Buffers every message of the current match and replays the buffer to any
 * client that connects mid-match, so a spectator who joins late still sees the bench, the
 * stream so far, and the market state. New match → buffer resets.
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { WsMessage } from "./wire.js";

export class Hub {
  private readonly wss: WebSocketServer;
  private buffer: WsMessage[] = [];

  /**
   * Bind the WebSocket hub to either a port (it creates+listens its own HTTP server) or an existing
   * `http.Server` (so the WS feed shares a port with the HTTP relay endpoint — one port for Railway).
   */
  constructor(portOrServer: number | HttpServer) {
    this.wss = typeof portOrServer === "number"
      ? new WebSocketServer({ port: portOrServer })
      : new WebSocketServer({ server: portOrServer });
    this.wss.on("connection", (socket: WebSocket) => {
      for (const msg of this.buffer) socket.send(JSON.stringify(msg));
    });
  }

  /** Reset the replay buffer at the start of a new match. */
  reset() {
    this.buffer = [];
  }

  /** Resolve once at least one client is connected — so the match starts with a live audience. */
  async waitForFirstClient(timeoutMs = 0): Promise<void> {
    if (this.wss.clients.size > 0) return;
    await new Promise<void>((resolve) => {
      const onConn = () => { this.wss.off("connection", onConn); resolve(); };
      this.wss.on("connection", onConn);
      if (timeoutMs > 0) setTimeout(() => { this.wss.off("connection", onConn); resolve(); }, timeoutMs);
    });
  }

  broadcast(msg: WsMessage) {
    this.buffer.push(msg);
    const data = JSON.stringify(msg);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }
}
