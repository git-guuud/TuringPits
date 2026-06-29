/**
 * Client for the optional spoken-dialogue layer. Talks to the server's POST /tts (server/src/tts.ts),
 * which tone-tags the line and synthesizes it through ElevenLabs — all keys stay server-side.
 *
 * URL resolution mirrors contract.ts:resolveRelayBase / feed.ts:resolveWsUrl so ONE tunnel covers the
 * UI, the feed, the relay, and now the voices:
 *   - localhost → http://localhost:8080 (talk straight to the server; CORS is set server-side)
 *   - any other origin → same host (Vite proxies /tts to :8080 — see vite.config.ts)
 *
 * The whole layer is gated: `ttsInfo()` returns null unless the server reports a key is configured, so
 * the UI only shows the voice control (and only ever fetches audio) when speech can actually be made.
 */

function resolveTtsBase(): string {
  const override = import.meta.env.VITE_TTS_URL as string | undefined;
  if (override) return override.replace(/\/$/, "");
  const { hostname, host, protocol } = window.location;
  if (hostname === "localhost" || hostname === "127.0.0.1") return "http://localhost:8080";
  return `${protocol === "https:" ? "https" : "http"}://${host}`;
}

export interface TtsInfo {
  enabled: boolean;
  model: string;
  tagger: "llm" | "heuristic";
}

let infoCache: Promise<TtsInfo | null> | null = null;

/** Discover whether the server can speak (cached). Returns null when disabled/unreachable. */
export function ttsInfo(): Promise<TtsInfo | null> {
  if (!infoCache) {
    infoCache = fetch(`${resolveTtsBase()}/tts/info`)
      .then((r) => (r.ok ? (r.json() as Promise<TtsInfo>) : null))
      .then((info) => (info?.enabled ? info : null))
      .catch(() => null);
  }
  return infoCache;
}

/** One dialogue line to voice — mirrors the server's POST /tts body. */
export interface SpeakLine {
  text: string;
  name: string;
  blurb?: string;
  kind: "vote" | "discussion";
  targetName?: string | null;
}

function keyOf(l: SpeakLine): string {
  return `${l.name}|${l.kind}|${l.targetName ?? ""}|${l.text}`;
}

// Cache object URLs by line so stepping back / re-watching reuses one fetch+blob instead of re-hitting
// the server. Bounded by the number of distinct lines in a match (a few dozen) — fine for the demo.
const clipCache = new Map<string, Promise<string>>();

/** Fetch (or reuse) a playable object URL for a line. Rejects on any transport/synthesis failure. */
export function fetchClip(line: SpeakLine): Promise<string> {
  const key = keyOf(line);
  let p = clipCache.get(key);
  if (!p) {
    p = fetch(`${resolveTtsBase()}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(line),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`tts ${r.status}`);
      return URL.createObjectURL(await r.blob());
    });
    clipCache.set(key, p);
    p.catch(() => clipCache.delete(key)); // don't cache a failure — allow a retry next time
  }
  return p;
}
