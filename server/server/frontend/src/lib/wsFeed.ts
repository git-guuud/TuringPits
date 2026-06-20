/**
 * Real WebSocket feed client. Connects to the Day-6 server (the `onTurn` sequencer) and
 * forwards parsed `WsMessage`s. NOT used yet — `feed.ts` selects the mock driver until the
 * server WebSocket lands. Implements the identical `MatchFeed` interface, so turning it on
 * is a one-line change. Kept here so the real path is a known quantity, not a future unknown.
 */
import type { MatchFeed, WsMessage } from "../lib/types.js";

export interface WsFeedOptions {
  readonly url: string;
  /** ms between reconnect attempts. */
  readonly reconnectMs?: number;
}

export function createWsFeed(opts: WsFeedOptions): MatchFeed {
  const reconnectMs = opts.reconnectMs ?? 1500;
  const listeners = new Set<(m: WsMessage) => void>();
  let socket: WebSocket | null = null;
  let closed = false;

  const emit = (m: WsMessage) => listeners.forEach((fn) => fn(m));

  function connect() {
    if (closed) return;
    socket = new WebSocket(opts.url);
    socket.onmessage = (ev) => {
      try {
        emit(JSON.parse(ev.data) as WsMessage);
      } catch {
        // ignore malformed frames; the server only ever sends WsMessage JSON
      }
    };
    socket.onclose = () => {
      if (!closed) setTimeout(connect, reconnectMs);
    };
    socket.onerror = () => socket?.close();
  }

  return {
    isMock: false,
    start() {
      connect();
    },
    subscribe(onMessage) {
      listeners.add(onMessage);
      return () => {
        listeners.delete(onMessage);
        if (listeners.size === 0) {
          closed = true;
          socket?.close();
        }
      };
    },
  };
}
