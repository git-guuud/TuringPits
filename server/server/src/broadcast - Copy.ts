/**
 * WebSocket hub. Buffers every message of the current match and replays the buffer to any
 * client that connects mid-match, so a spectator who joins late still sees the bench, the
 * stream so far, and the market state. New match → buffer resets.
 */
import { WebSocketServer, WebSocket } from "ws";
import type { WsMessage } from "./wire.js";

export class Hub {
  private readonly wss: WebSocketServer;
  private buffer: WsMessage[] = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (socket: WebSocket) => {
      for (const msg of this.buffer) socket.send(JSON.stringify(msg));
    });
  }

  /** Reset the replay buffer at the start of a new match. */
  reset() {
    this.buffer = [];
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
