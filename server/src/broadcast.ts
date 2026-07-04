/**
 * WebSocket hub. Buffers every message of the current match and replays the buffer to any
 * client that connects mid-match, so a spectator who joins late still sees the bench, the
 * stream so far, and the market state. New match → buffer resets.
 */
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { MarketState, WsMessage } from "./wire.js";

/**
 * A read-only snapshot of the current match, derived from the replay buffer alone (no chain reads,
 * no WS client). Served over `GET /status` so the lobby can show "is court in session, what round,
 * how big the pot" WITHOUT opening a socket — opening one would trip `waitForFirstClient` and start
 * a match. `live` is true while a match is in progress (a `match_init` has landed and no `settled`
 * has yet); it falls back to idle the moment the match settles or before any has begun.
 */
export interface MatchStatus {
  live: boolean;
  matchId: number | null;
  /** 1-based round in play; 0 before the first night/day beat (or when idle). */
  round: number;
  state: MarketState;
  bettingLive: boolean;
  yesPool: string;
  noPool: string;
  isMock: boolean;
}

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

  /**
   * Derive the current match status from the replay buffer. Pure read — never touches the socket or
   * the chain, so it can be polled freely (e.g. by the lobby) without starting a match. The buffer
   * is reset at each match start (orchestrator), so a stale match never leaks past the next one.
   */
  snapshot(): MatchStatus {
    let hasInit = false;
    let hasSettled = false;
    let matchId: number | null = null;
    let isMock = false;
    let round = 0;
    let state: MarketState = "OPEN";
    let bettingLive = false;
    let yesPool = "0";
    let noPool = "0";
    for (const m of this.buffer) {
      switch (m.type) {
        case "match_init":
          hasInit = true;
          matchId = m.matchId;
          isMock = m.isMock;
          break;
        case "market":
          state = m.market.state;
          bettingLive = !!m.market.bettingLive;
          yesPool = m.market.yesPool;
          noPool = m.market.noPool;
          break;
        case "night":
        case "dawn":
        case "discussion":
        case "bet_window":
          round = Math.max(round, m.round);
          break;
        case "turn":
          round = Math.max(round, m.state.round);
          break;
        case "settled":
          hasSettled = true;
          state = "SETTLED";
          break;
      }
    }
    return { live: hasInit && !hasSettled, matchId, round, state, bettingLive, yesPool, noPool, isMock };
  }
}
