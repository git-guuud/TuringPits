/**
 * Optional spoken-dialogue layer (text-to-speech for the players' lines).
 *
 * Pipeline (matching the demo's "tone indicators, then ElevenLabs" intent):
 *   line of dialogue  →  TONE-TAG step  →  ElevenLabs v3 synthesis  →  mp3
 *
 * The TONE-TAG step inserts ElevenLabs v3 audio tags ([nervous], [accusing], [whispers]…) so the
 * delivery matches the moment. When NVIDIA_NIM_API_KEY is set it uses a fast NVIDIA NIM call (the
 * OpenAI-compatible hosted catalog at integrate.api.nvidia.com) that reads the line + game context;
 * otherwise it falls back to a cheap heuristic derived from the vote/discussion context already on the
 * wire. Each persona gets its OWN voice (server/src/voices.ts).
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
  /**
   * ElevenLabs API key(s). Accepts a SINGLE key, or several separated by commas/whitespace — the free
   * tier's character quota is tiny (2-3 matches), so a pool lets synthesis roll over to the next key
   * when one runs out of credit (see {@link KeyPool}/{@link synthWithRotation}). Empty ⇒ feature disabled.
   */
  apiKey: string;
  /** ElevenLabs model. `eleven_v3` understands the tone tags; `eleven_multilingual_v2` ignores them. */
  modelId: string;
  /** name → voiceId. */
  voiceMap: Record<string, string>;
  /** Voice for any unmapped persona name. */
  defaultVoiceId: string;
  /** NVIDIA NIM key (nvapi-…) for the LLM tone-tagger. Empty ⇒ heuristic tags. */
  nimApiKey?: string;
  /**
   * Fast NIM catalog model for the tagger (default meta/llama-3.1-8b-instruct). Keep it SMALL — on the
   * free catalog a big model (e.g. llama-3.3-70b) can queue for minutes, while the 8b answers sub-second;
   * a slow tag falls back to the heuristic anyway (see {@link taggerTimeoutMs}) but wastes the window.
   */
  llmModel?: string;
  /** Abort the tagger call after this many ms and fall back to the heuristic (default 6000). */
  taggerTimeoutMs?: number;
  /** Per-IP token bucket for POST /tts (abuse guard). */
  rateBurst?: number;
  rateRefillMs?: number;
  /** Max characters accepted for a single line. */
  maxTextLength?: number;
  /**
   * Bitrate (kbps) of the mp3 ElevenLabs returns — used to estimate a clip's play length for stage
   * pacing. We never override `output_format`, so this is the endpoint default (128). Override only if
   * a custom `output_format` is ever set.
   */
  audioBitrateKbps?: number;
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
  /**
   * Synthesize (or reuse cached) the line and return its approximate play length in ms — so the match
   * orchestrator can pace the stage to the actual spoken duration. Also warms the cache the client will
   * hit. Throws on synth failure so the caller can fall back to a text estimate. */
  durationMs(input: ToneInput): Promise<number>;
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
 * The ElevenLabs v3 audio tags we allow through to synthesis — the exact set the LLM tagger is told to
 * use (see the system prompt below). v3 is alpha and will SPEAK ALOUD any bracketed token it does not
 * recognise as a delivery cue, so this allow-list is the guard that stops the voice from reading a
 * drifting tagger's "[leans forward]" — or a stage direction leaked out of the player's own dialogue —
 * out loud. Anything not in here is stripped before the line ever reaches ElevenLabs.
 */
export const RECOGNIZED_TAGS: ReadonlySet<string> = new Set([
  "nervous",
  "accusing",
  "whispers",
  "sarcastic",
  "serious",
  "curious",
  "excited",
  "angry",
  "sighs",
]);

/**
 * Drop every bracketed segment that is not a recognised v3 audio tag, so nothing unintended is ever
 * voiced literally. Recognised tags are normalised to their lower-case `[tag]` form and kept inline;
 * everything else — `[clears throat]`, `[leans in]`, a player-leaked stage direction — is removed, and
 * the whitespace the removal leaves behind (double spaces, a space before punctuation) is collapsed.
 * Applied to whatever the tagger returns (LLM or heuristic) as the final step before synthesis.
 */
export function sanitizeTaggedLine(text: string): string {
  const stripped = text.replace(/\[([^\]]*)\]/g, (_whole, inner: string) => {
    const tag = inner.trim().toLowerCase();
    return RECOGNIZED_TAGS.has(tag) ? `[${tag}]` : "";
  });
  return stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

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

/**
 * Parse + validate a tone-tagger model reply against the line it was handed. Returns the tagged line on
 * success; throws when the model returned nothing, or DRIFTED from the original wording (a chatty model
 * that rewrote or answered the line instead of only inserting tags) so the caller can fall back to the
 * heuristic. The drift check de-tags the reply and requires it to still contain the start of the line.
 */
export function parseTaggerResponse(modelText: string | undefined, originalLine: string): string {
  const text = modelText?.trim();
  if (!text) throw new Error("tagger returned no text");
  // Keep the tags ONLY when the de-tagged reply is word-for-word the original — otherwise discard and let
  // the caller fall back to the heuristic. This rejects a chatty model that rewrote the line AND a small
  // model that APPENDED words (both would make the voice speak text the player never said). `norm` drops
  // the tags, folds whitespace + the space a tag leaves before punctuation (`Vesper [serious].` →
  // `Vesper .`) the way sanitizeTaggedLine does, and folds smart quotes, so a faithful tagging that only
  // differs by inserted tags/spacing/quote-style still matches exactly.
  const norm = (s: string) =>
    s
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, " ")
      .replace(/\s+([.,!?;:])/g, "$1")
      .trim()
      .toLowerCase();
  if (norm(text) !== norm(originalLine)) {
    throw new Error("tagger drifted from the original line");
  }
  return text;
}

/**
 * Call a fast NVIDIA NIM model to insert v3 tone tags. Uses the OpenAI-compatible chat-completions
 * endpoint on the hosted catalog (integrate.api.nvidia.com). Throws on any failure so the caller can
 * fall back to the heuristic.
 */
async function llmTaggedText(
  input: ToneInput,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<string> {
  const system =
    "You add ElevenLabs v3 audio tags to a single line of dialogue spoken by an AI playing the " +
    "social-deduction game Mafia, so the voice delivery matches the moment. Insert 1-3 bracketed " +
    "tags inline at natural points. Use ONLY these tags and NO others: [nervous], [accusing], " +
    "[whispers], [sarcastic], [serious], [curious], [excited], [angry], [sighs]. Never invent a tag " +
    "and never write a stage direction in brackets. Do NOT change, add, or remove any spoken words. " +
    "Return ONLY the same line with tags inserted — no quotes, no preamble, no explanation.";
  const ctx =
    input.kind === "vote"
      ? `Context: this is a VOTE to convict ${input.targetName ?? "another player"}.`
      : "Context: this is open deliberation at the table.";
  const persona = input.blurb ? ` whose manner is "${input.blurb}"` : "";
  const user = `Speaker ${input.name}${persona}. ${ctx}\nLine: ${input.text}`;

  // Bound the call: the free NIM catalog can queue a busy model for minutes, and this runs on the
  // stage-pacing path — a hung tag must fall back to the heuristic fast, not freeze the match.
  const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 300,
      temperature: 0.5,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`nvidia nim ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  return parseTaggerResponse(text, input.text);
}

// ── real ElevenLabs synthesis ──────────────────────────────────────────────────

/** A non-2xx ElevenLabs response, carrying the status + raw body so callers can classify it. */
export class ElevenLabsError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`elevenlabs ${status}: ${body.slice(0, 200)}`);
    this.name = "ElevenLabsError";
  }
}

/**
 * True when the key itself is UNUSABLE and a different key could succeed — so the pool should roll over.
 * Two cases, both HTTP 401 from ElevenLabs: out of credit (`quota_exceeded`) and a rejected key
 * (`invalid_api_key` / revoked / flagged). Deliberately EXCLUDES a paywalled-voice/feature 402
 * (`paid_plan_required`) and a rate-limit 429 (`too_many_concurrent_requests`): those fail identically on
 * every key, so rotating would just burn the whole pool. (`quota` is also matched by body text as a
 * belt-and-suspenders guard in case the status ever shifts off 401.)
 */
export function isKeyExhausted(err: unknown): boolean {
  if (!(err instanceof ElevenLabsError)) return false;
  return err.status === 401 || /quota/i.test(err.body);
}

/** Split a comma/whitespace-separated key string into a de-duplicated, trimmed list (empties dropped). */
export function parseKeys(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
}

/**
 * An ordered pool of ElevenLabs keys with a single "active" cursor. Keys are used one at a time; when the
 * active one runs out of credit it is RETIRED (the cursor advances) and never used again this process.
 * `retire` is idempotent under concurrency — parallel synths that all hit the same exhausted key advance
 * the cursor once, not once per caller — because it only advances when the passed key is still the active.
 */
export class KeyPool {
  private readonly keys: string[];
  private idx = 0;
  constructor(keys: string[]) {
    this.keys = [...new Set(keys)]; // a duplicate key would waste a rotation hop
  }
  get size(): number {
    return this.keys.length;
  }
  /** The key to use right now, or undefined once the whole pool is exhausted. */
  get active(): string | undefined {
    return this.keys[this.idx];
  }
  /** Retire `key` if it is still active (out of credit), and return the next active key (or undefined). */
  retire(key: string): string | undefined {
    if (this.keys[this.idx] === key) {
      this.idx++;
      const remaining = this.keys.length - this.idx;
      console.warn(
        remaining > 0
          ? `[tts] elevenlabs key ${this.idx}/${this.keys.length} out of credit — rotating (${remaining} left)`
          : `[tts] elevenlabs: all ${this.keys.length} key(s) out of credit`,
      );
    }
    return this.active;
  }
}

/**
 * Run a per-key synthesis, rolling forward through the pool: when the active key is UNUSABLE (out of
 * credit / rejected — see {@link isKeyExhausted}) it is retired and the SAME synthesis is retried with
 * the next key, until one succeeds or the pool is drained. Any other error (rate-limit, paywalled voice,
 * network) propagates immediately — another key won't fix it. The tone-tagging has already happened
 * upstream, so a rotation only re-issues the (cheap) ElevenLabs call, never a re-tag.
 */
export async function synthWithRotation(
  pool: KeyPool,
  synthOne: (apiKey: string) => Promise<Buffer>,
): Promise<Buffer> {
  for (;;) {
    const key = pool.active;
    if (!key) throw new Error("elevenlabs: no api key configured");
    try {
      return await synthOne(key);
    } catch (e) {
      if (isKeyExhausted(e) && pool.retire(key)) continue; // rotated to a fresh key — retry
      throw e; // not a key-level failure, or the pool is now drained
    }
  }
}

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
    throw new ElevenLabsError(res.status, detail);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── play-length estimation (for stage pacing) ──────────────────────────────────

/** Clamp a pacing duration to a sane window so a stray estimate can't stall or rush the stage. */
const clampDur = (ms: number): number => Math.min(30_000, Math.max(1_500, Math.round(ms)));

/**
 * Approximate the play length (ms) of an ElevenLabs mp3 from its byte size. The TTS endpoint returns
 * CBR mp3 at the default 128 kbps (we never override output_format), so duration ≈ bits / bitrate. The
 * couple-KB ID3 header makes this a slight OVER-estimate on short clips, which is the safe direction for
 * pacing (a touch of silence beats a clipped word). Clamped to a sane window.
 */
export function estimateMp3DurationMs(byteLength: number, bitrateKbps = 128): number {
  if (byteLength <= 0 || bitrateKbps <= 0) return 0;
  return clampDur((byteLength * 8) / bitrateKbps); // bytes*8 bits ÷ kbps = ms
}

/**
 * Fallback play-length (ms) estimate from the TEXT alone, for when synthesis is unavailable (TTS off,
 * or a synth call that timed out/failed). ElevenLabs v3 speaks at ~14 chars/sec; clamped so a stray
 * very-short or very-long line can't mis-pace the stage.
 */
export function estimateSpeechMs(text: string, charsPerSec = 14): number {
  const chars = text.trim().length;
  if (chars === 0) return 0;
  return clampDur((chars / charsPerSec) * 1000);
}

// ── factory ──────────────────────────────────────────────────────────────────

const MAX_CACHE = 256;

export function createTts(cfg: TtsConfig, deps: TtsDeps = {}): Tts {
  const keyPool = new KeyPool(parseKeys(cfg.apiKey));
  const enabled = !!(deps.synth || keyPool.size);
  const hasLlm = !!cfg.nimApiKey;
  const llmModel = cfg.llmModel || "meta/llama-3.1-8b-instruct";
  const taggerTimeoutMs = cfg.taggerTimeoutMs ?? 6000;
  const maxText = cfg.maxTextLength ?? 600;

  const tag: (input: ToneInput) => Promise<string> =
    deps.tag ??
    (async (input) => {
      if (hasLlm) {
        try {
          return await llmTaggedText(input, cfg.nimApiKey!, llmModel, taggerTimeoutMs);
        } catch (e) {
          console.warn(`[tts] tagger fell back to heuristic: ${(e as Error).message}`);
        }
      }
      return heuristicTaggedText(input);
    });

  const synth: (text: string, voiceId: string) => Promise<Buffer> =
    deps.synth ??
    ((text, voiceId) => synthWithRotation(keyPool, (key) => elevenLabsSynth(key, cfg.modelId, text, voiceId)));

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
      // Final guard: strip any bracketed token that isn't a recognised v3 audio tag, so a drifting
      // tagger (or a stage direction leaked from the player's own line) is never read out loud.
      return synth(sanitizeTaggedLine(tagged), voiceId);
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

  async function durationMs(input: ToneInput): Promise<number> {
    const audio = await getAudio(input);
    return estimateMp3DurationMs(audio.length, cfg.audioBitrateKbps ?? 128);
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
    durationMs,
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
