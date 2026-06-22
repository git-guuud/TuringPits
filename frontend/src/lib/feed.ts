/**
 * The match feed. Production: a WebSocket to the live server (the `onTurn` sequencer).
 *
 * URL resolution (so a shared tunnel "just works" without hand-editing per session):
 *   1. `VITE_WS_URL` if set — an explicit override always wins.
 *   2. localhost → `ws://localhost:8080` (talk straight to the server in local dev).
 *   3. any other origin (e.g. an ngrok share) → `wss?://<same-host>/ws`, which the Vite dev server
 *      PROXIES to the match server on :8080 (see vite.config.ts). A remote viewer's browser then
 *      connects back through the SAME tunnel that served the page — one ngrok tunnel covers both the
 *      UI and the live feed, and the per-session public URL never gets baked into the bundle.
 *
 * There is no mock replay — the server runs the real engine/players match and streams it.
 *
 *   # frontend/.env.local (optional override)
 *   VITE_WS_URL=ws://localhost:8080
 */
import type { MatchFeed } from "./types.js";
import { createWsFeed } from "./wsFeed.js";

function resolveWsUrl(): string {
  const override = import.meta.env.VITE_WS_URL as string | undefined;
  if (override) return override;
  const { hostname, host, protocol } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "ws://localhost:8080";
  const scheme = protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${host}/ws`;
}

export function createFeed(): MatchFeed {
  return createWsFeed({ url: resolveWsUrl() });
}
