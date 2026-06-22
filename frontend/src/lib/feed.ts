/**
 * The match feed. Production: a WebSocket to the live server (the `onTurn` sequencer).
 *
 * The server URL comes from `VITE_WS_URL`, defaulting to the local dev server. There is no
 * mock replay any more — the server runs the real engine/players match and streams it, so the
 * app runs end-to-end from the repository with no hand-authored data.
 *
 *   # frontend/.env.local (optional; this is the default)
 *   VITE_WS_URL=ws://localhost:8080
 */
import type { MatchFeed } from "./types.js";
import { createWsFeed } from "./wsFeed.js";

export function createFeed(): MatchFeed {
  const url = (import.meta.env.VITE_WS_URL as string | undefined) || "ws://localhost:8080";
  return createWsFeed({ url });
}
