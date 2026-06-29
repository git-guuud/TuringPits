/**
 * Optional spoken-dialogue layer (text-to-speech for the players' lines).
 *
 * Pipeline (matching the demo's "tone indicators, then ElevenLabs" intent):
 *   line of dialogue  →  TONE-TAG step  →  ElevenLabs v3 synthesis  →  mp3
 *
 * The TONE-TAG step inserts ElevenLabs v3 audio tags ([nervous], [accusing], [whispers]…) so the
 * delivery matches the moment. When ANTHROPIC_API_KEY is set it uses a fast Claude Haiku call that
 * reads the line + game context; otherwise it falls back to a cheap heuristic derived from the
 * vote/discussion context already on the wire. Each persona gets its OWN voice (server/src/voices.ts).
 *
 * OPTIONAL at every layer: this only activates when ELEVENLABS_API_KEY is set. With no key,
 * `GET /tts/info` reports `enabled:false` and the frontend simply never speaks (the typewriter still
 * runs). The keys live ONLY here, server-side — they are never shipped to the browser.
 *
 * Routes (mounted by index.ts on the same HTTP port as the WebSocket hub):
 *   GET  /tts/info  → { enabled, model, tagger }
 *   POST /tts       → audio/mpeg   body: { text, name, blurb?, kind?, targetName? }
 *
 * The frontend requests a clip when a speech beat reaches the stage and plays it alongside the
 * typewriter (frontend/src/lib/voice.ts). Clips are cached + deduped server-side by content, so
 * replays and multiple spectators reuse one synthesis instead of re-spending credits.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { voiceFor } from "./voices.js";

/** The dialogue line + the game context the tone-tagger uses to pick a delivery. */
export interface ToneInput {
  text: string;
  /** Speaking persona (for the voice + the tagger's framing). */
  name: string;
  /** The persona's speaking-style blurb (public; sent by the client) — steers the LLM tagger. */
  blurb?: string;
  /** "vote" = a day vote naming a target (accusatory); "discussion" = open deliberation. */
  kind: "vote" | "discussion";
  /** For a vote, who is being accused (for the tagger's framing). */
  targetName?: string | null;
}

export interface TtsConfig {
  /** ElevenLabs API key. Empty ⇒ the whole feature is disabled. */
  apiKey: string;
  /** ElevenLabs model. `eleven_v3` understands the tone tags; `eleven_multilingual_v2` ignores them. */
  modelId: string;
  /** name → voiceId. */
  voiceMap: Record<string, string>;
  /** Voice for any unmapped persona name. */
  defaultVoiceId: string;
  /** Anthropic key for the LLM tone-tagger. Empty ⇒ heuristic tags. */
  anthropicApiKey?: string;
  /** Fast model for the tagger (default claude-haiku-4-5). */
  llmModel?: string;
  /** Per-IP token bucket for POST /tts (abuse guard). */
  rateBurst?: number;
  rateRefillMs?: number;
  /** Max characters accepted for a single line. */
  maxTextLength?: number;
}

/** Inject fakes in tests (no network); production uses the real ElevenLabs + Anthropic calls. */
export interface TtsDeps {
  /** tagged text + voiceId → mp3 bytes. */
  synth?: (text: string, voiceId: string) => Promise<Buffer>;
  /** dialogue line → the same line with tone tags inserted. */
  tag?: (input: ToneInput) => Promise<string>;
}

export interface Tts {
  readonly enabled: boolean;
  /** Try to handle an HTTP request; true if it owned the route (else the caller falls through). */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Synthesize (or return cached) audio for a line. Exposed for tests/reuse. */
  getAudio(input: ToneInput): Promise<Buffer>;
  info(): { enabled: boolean; model: string; tagger: "llm" | "heuristic" };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** A simple per-key token bucket (kept local so this module pulls in no heavy deps). */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();
  constructor(private readonly burst: number, private readonly refillMs: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: now };
    const refilled = Math.min(this.burst, b.tokens + (now - b.last) / this.refillMs);
    if (refilled < 1) {
      this.buckets.set(key, { tokens: refilled, last: now });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, last: now });
    return true;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limitBytes = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limitBytes) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function clientKey(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket?.remoteAddress || "anon";
}

// ── tone tagging ─────────────────────────────────────────────────────────────

/**
 * Heuristic tone tags from the game context already on the wire — no extra LLM call. A day vote is
 * pointed; a question is curious; an exclamation is heated. Tags from ElevenLabs v3's recognised set.
 */
export function heuristicTaggedText(input: ToneInput): string {
  const t = input.text.trim();
  let tag = "";
  if (input.kind === "vote") tag = "[serious]";
  else if (/\?["')]*\s*$/.test(t)) tag = "[curious]";
  else if (/!["')]*\s*$/.test(t)) tag = "[excited]";
  return tag ? `${tag} ${input.text}` : input.text;
}

/** Call a fast Claude model to insert v3 tone tags. Throws on any failure so the caller can fall back. */
async function llmTaggedText(input: ToneInput, apiKey: string, model: string): Promise<string> {
  const system =
    "You add ElevenLabs v3 audio tags to a single line of dialogue spoken by an AI playing the " +
    "social-deduction game Mafia, so the voice delivery matches the moment. Insert 1-3 bracketed " +
    "tags inline at natural points (e.g. [nervous], [accusing], [whispers], [sarcastic], [serious], " +
    "[curious], [excited], [angry], [sighs]). Do NOT change, add, or remove any words. Return ONLY " +
    "the same line with tags inserted — no quotes, no preamble, no explanation.";
  const ctx =
    input.kind === "vote"
      ? `Context: this is a VOTE to convict ${input.targetName ?? "another player"}.`
      : "Context: this is open deliberation at the table.";
  const persona = input.blurb ? ` whose manner is "${input.blurb}"` : "";
  const user = `Speaker ${input.name}${persona}. ${ctx}\nLine: ${input.text}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0.5,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}`);
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text || !text.trim()) throw new Error("anthropic returned no text");
  // Guard against a chatty model: if the words drifted, keep tags only when the de-tagged line still
  // contains the original — otherwise discard and let the caller fall back to the heuristic.
  const stripped = text.replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const original = input.text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!stripped.includes(original.slice(0, Math.min(original.length, 24)))) {
    throw new Error("tagger drifted from the original line");
  }
  return text.trim();
}

// ── real ElevenLabs synthesis ──────────────────────────────────────────────────

async function elevenLabsSynth(apiKey: string, modelId: string, text: string, voiceId: string): Promise<Buffer> {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "content-type": "application/json",
      accept: "audio/mpeg",
    },
    body: JSON.stringify({ text, model_id: modelId }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`elevenlabs ${res.status}: ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── factory ──────────────────────────────────────────────────────────────────

const MAX_CACHE = 256;

export function createTts(cfg: TtsConfig, deps: TtsDeps = {}): Tts {
  const enabled = !!(deps.synth || cfg.apiKey);
  const hasLlm = !!cfg.anthropicApiKey;
  const llmModel = cfg.llmModel || "claude-haiku-4-5";
  const maxText = cfg.maxTextLength ?? 600;

  const tag: (input: ToneInput) => Promise<string> =
    deps.tag ??
    (async (input) => {
      if (hasLlm) {
        try {
          return await llmTaggedText(input, cfg.anthropicApiKey!, llmModel);
        } catch (e) {
          console.warn(`[tts] tagger fell back to heuristic: ${(e as Error).message}`);
        }
      }
      return heuristicTaggedText(input);
    });

  const synth: (text: string, voiceId: string) => Promise<Buffer> =
    deps.synth ?? ((text, voiceId) => elevenLabsSynth(cfg.apiKey, cfg.modelId, text, voiceId));

  // Content-addressed cache + in-flight dedupe: identical lines (replays, many viewers) synthesize once.
  const cache = new Map<string, Buffer>();
  const pending = new Map<string, Promise<Buffer>>();
  const limiter = new RateLimiter(cfg.rateBurst ?? 120, cfg.rateRefillMs ?? 500);

  async function getAudio(input: ToneInput): Promise<Buffer> {
    const voiceId = voiceFor(input.name, cfg.voiceMap, cfg.defaultVoiceId);
    const key = createHash("sha256")
      .update(`${voiceId}\n${input.kind}\n${input.targetName ?? ""}\n${input.text}`)
      .digest("hex");
    const hit = cache.get(key);
    if (hit) return hit;
    const inflight = pending.get(key);
    if (inflight) return inflight;

    const p = (async () => {
      const tagged = await tag(input);
      return synth(tagged, voiceId);
    })();
    pending.set(key, p);
    try {
      const audio = await p;
      cache.set(key, audio);
      if (cache.size > MAX_CACHE) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest) cache.delete(oldest);
      }
      return audio;
    } finally {
      pending.delete(key);
    }
  }

  function info() {
    return { enabled, model: cfg.modelId, tagger: hasLlm ? ("llm" as const) : ("heuristic" as const) };
  }

  async function handlePost(req: IncomingMessage, res: ServerResponse) {
    if (!enabled) {
      sendJson(res, 503, { error: "tts disabled (set ELEVENLABS_API_KEY)" });
      return;
    }
    if (!limiter.take(clientKey(req))) {
      sendJson(res, 429, { error: "rate limit — slow down" });
      return;
    }
    let body: { text?: unknown; name?: unknown; blurb?: unknown; kind?: unknown; targetName?: unknown };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return;
    }
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      sendJson(res, 400, { error: "text required" });
      return;
    }
    if (text.length > maxText) {
      sendJson(res, 400, { error: `text too long (max ${maxText})` });
      return;
    }
    const input: ToneInput = {
      text,
      name: typeof body.name === "string" ? body.name : "",
      blurb: typeof body.blurb === "string" ? body.blurb : undefined,
      kind: body.kind === "vote" ? "vote" : "discussion",
      targetName: typeof body.targetName === "string" ? body.targetName : null,
    };
    try {
      const audio = await getAudio(input);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", ...CORS });
      res.end(audio);
    } catch (e) {
      console.error("[tts] synthesis failed:", (e as Error).message);
      sendJson(res, 502, { error: "synthesis failed" });
    }
  }

  return {
    enabled,
    getAudio,
    info,
    async handle(req, res) {
      const url = (req.url ?? "").split("?")[0];
      if (url !== "/tts" && url !== "/tts/info") return false;
      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS);
        res.end();
        return true;
      }
      if (url === "/tts/info" && req.method === "GET") {
        sendJson(res, 200, info());
        return true;
      }
      if (url === "/tts" && req.method === "POST") {
        await handlePost(req, res);
        return true;
      }
      sendJson(res, 405, { error: "method not allowed" });
      return true;
    },
  };
}
