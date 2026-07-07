import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createTts,
  heuristicTaggedText,
  parseTaggerResponse,
  sanitizeTaggedLine,
  estimateMp3DurationMs,
  estimateSpeechMs,
  RECOGNIZED_TAGS,
  parseKeys,
  isKeyExhausted,
  KeyPool,
  synthWithRotation,
  ElevenLabsError,
  type ToneInput,
} from "./tts.js";
import { DEFAULT_VOICE_MAP, DEFAULT_FALLBACK_VOICE, loadVoiceMap, voiceFor } from "./voices.js";

// ── fake http req/res ─────────────────────────────────────────────────────────
function fakeReq(method: string, url: string, body?: string): IncomingMessage {
  const r = new EventEmitter() as unknown as IncomingMessage & EventEmitter;
  (r as { method: string }).method = method;
  (r as { url: string }).url = url;
  (r as { headers: object }).headers = {};
  (r as { socket: { remoteAddress: string } }).socket = { remoteAddress: "1.2.3.4" };
  if (method === "POST") {
    process.nextTick(() => {
      if (body !== undefined) r.emit("data", Buffer.from(body));
      r.emit("end");
    });
  }
  return r;
}

class FakeRes {
  statusCode = 0;
  headers: Record<string, string> = {};
  private chunks: Buffer[] = [];
  ended = false;
  writeHead(status: number, headers?: Record<string, string>) {
    this.statusCode = status;
    if (headers) this.headers = { ...this.headers, ...headers };
    return this;
  }
  write(chunk: unknown) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }
  end(chunk?: unknown) {
    if (chunk !== undefined) this.write(chunk);
    this.ended = true;
  }
  get body(): Buffer {
    return Buffer.concat(this.chunks);
  }
  get text(): string {
    return this.body.toString();
  }
  json(): unknown {
    return JSON.parse(this.text);
  }
}
const res = () => new FakeRes() as unknown as ServerResponse & FakeRes;

const baseCfg = {
  apiKey: "",
  modelId: "eleven_v3",
  voiceMap: { ...DEFAULT_VOICE_MAP },
  defaultVoiceId: DEFAULT_FALLBACK_VOICE,
};

const line = (over: Partial<ToneInput> = {}): ToneInput => ({
  text: "I think Vesper is hiding something.",
  name: "Atlas",
  kind: "discussion",
  ...over,
});

describe("voices", () => {
  it("maps known persona names and falls back for unknown ones", () => {
    expect(voiceFor("Atlas", DEFAULT_VOICE_MAP, DEFAULT_FALLBACK_VOICE)).toBe(DEFAULT_VOICE_MAP.Atlas);
    expect(voiceFor("Nobody", DEFAULT_VOICE_MAP, DEFAULT_FALLBACK_VOICE)).toBe(DEFAULT_FALLBACK_VOICE);
    // every roster persona has a distinct voice
    const ids = Object.values(DEFAULT_VOICE_MAP);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("merges ELEVENLABS_VOICE_MAP over the defaults and ignores malformed JSON", () => {
    const merged = loadVoiceMap('{"Atlas":"custom-id","Zed":"zed-id"}');
    expect(merged.Atlas).toBe("custom-id");
    expect(merged.Zed).toBe("zed-id");
    expect(merged.Vesper).toBe(DEFAULT_VOICE_MAP.Vesper); // untouched default
    expect(loadVoiceMap("not json").Atlas).toBe(DEFAULT_VOICE_MAP.Atlas); // falls back to defaults
  });
});

describe("heuristic tone tags", () => {
  it("tags a vote as serious", () => {
    expect(heuristicTaggedText(line({ kind: "vote", text: "I vote for Vesper." }))).toBe(
      "[serious] I vote for Vesper.",
    );
  });
  it("tags a question as curious and an exclamation as excited", () => {
    expect(heuristicTaggedText(line({ text: "Why so quiet, Nova?" }))).toBe("[curious] Why so quiet, Nova?");
    expect(heuristicTaggedText(line({ text: "That makes no sense!" }))).toBe("[excited] That makes no sense!");
  });
  it("leaves a plain statement untagged", () => {
    expect(heuristicTaggedText(line({ text: "Let us hear from the doctor." }))).toBe(
      "Let us hear from the doctor.",
    );
  });
});

describe("sanitizeTaggedLine — keep recognized v3 tags, strip everything else", () => {
  it("keeps a recognized tag and leaves plain words untouched", () => {
    expect(sanitizeTaggedLine("[nervous] I think it's Vesper.")).toBe("[nervous] I think it's Vesper.");
    expect(sanitizeTaggedLine("No tags here at all.")).toBe("No tags here at all.");
  });

  it("strips an unrecognized tag (a stage direction v3 would speak aloud)", () => {
    expect(sanitizeTaggedLine("[leans forward] You're lying.")).toBe("You're lying.");
    expect(sanitizeTaggedLine("I saw it [clears throat] last round.")).toBe("I saw it last round.");
  });

  it("removes a player-leaked bracket while keeping a real tag", () => {
    expect(sanitizeTaggedLine("[accusing] It was [whispers to himself] you all along.")).toBe(
      "[accusing] It was you all along.",
    );
  });

  it("normalizes tag casing/whitespace to the canonical [tag] form", () => {
    expect(sanitizeTaggedLine("[ SERIOUS ] We vote now.")).toBe("[serious] We vote now.");
  });

  it("collapses the gaps left by stripped tags, including before punctuation", () => {
    expect(sanitizeTaggedLine("Wait [pauses] , who said that?")).toBe("Wait, who said that?");
    expect(sanitizeTaggedLine("[unknown]   leading junk")).toBe("leading junk");
  });

  it("every recognized tag survives the sanitizer round-trip", () => {
    for (const tag of RECOGNIZED_TAGS) {
      expect(sanitizeTaggedLine(`[${tag}] line`)).toBe(`[${tag}] line`);
    }
  });

  it("the heuristic tagger's output always survives sanitization", () => {
    const vote = heuristicTaggedText(line({ kind: "vote", text: "I vote Vesper." }));
    const question = heuristicTaggedText(line({ text: "Why so quiet?" }));
    expect(sanitizeTaggedLine(vote)).toBe(vote);
    expect(sanitizeTaggedLine(question)).toBe(question);
  });
});

describe("parseTaggerResponse — validate the LLM tagger reply against the line it was given", () => {
  const original = "I think Vesper is hiding something.";

  it("returns a tagged reply whose words still match the original", () => {
    const tagged = "[nervous] I think Vesper is hiding something. [accusing]";
    expect(parseTaggerResponse(tagged, original)).toBe(tagged);
  });

  it("trims surrounding whitespace from the reply", () => {
    expect(parseTaggerResponse(`  [serious] ${original}\n`, original)).toBe(`[serious] ${original}`);
  });

  it("throws on an empty or missing reply", () => {
    expect(() => parseTaggerResponse(undefined, original)).toThrow(/no text/);
    expect(() => parseTaggerResponse("   ", original)).toThrow(/no text/);
  });

  it("throws when the model rewrote the line instead of only tagging it (drift)", () => {
    // A chatty model that answered/rewrote rather than inserting tags must be rejected so the caller
    // falls back to the heuristic instead of voicing words the player never said.
    expect(() => parseTaggerResponse("[curious] Sure! Here is a punchier version of that.", original)).toThrow(
      /drift/,
    );
  });

  it("accepts a reply that only differs by inserted tags and spacing", () => {
    const tagged = "[serious] I think Vesper [whispers] is hiding something.";
    expect(() => parseTaggerResponse(tagged, original)).not.toThrow();
  });

  it("accepts a tag placed right before punctuation (the space it leaves is not drift)", () => {
    // Observed from NIM: a tag before the period leaves `something [nervous].` → de-tags to
    // `something .`; the guard must normalize that space, not reject a faithful tagging.
    const tagged = "I think Vesper is hiding something [nervous]. [accusing]";
    expect(parseTaggerResponse(tagged, original)).toBe(tagged);
  });

  it("throws when a small model APPENDED words beyond the original line", () => {
    // Observed from llama-3.1-8b: it kept the line but tacked on a fabricated continuation. The voice
    // must never speak words the player never said, so a reply longer than the original is rejected.
    const appended = "I think Vesper is hiding something [accusing] and she keeps dodging every question.";
    expect(() => parseTaggerResponse(appended, original)).toThrow(/drift/);
  });
});

describe("play-length estimation (stage pacing)", () => {
  it("derives mp3 duration from byte size at the default 128 kbps", () => {
    // 160 000 bytes × 8 ÷ 128 kbps = 10 000 ms
    expect(estimateMp3DurationMs(160_000)).toBe(10_000);
    expect(estimateMp3DurationMs(80_000)).toBe(5_000);
  });

  it("honors a custom bitrate", () => {
    expect(estimateMp3DurationMs(160_000, 64)).toBe(20_000);
  });

  it("clamps degenerate sizes into the pacing window and treats empty as zero", () => {
    expect(estimateMp3DurationMs(0)).toBe(0);
    expect(estimateMp3DurationMs(10)).toBe(1_500); // tiny clip floored
    expect(estimateMp3DurationMs(100_000_000)).toBe(30_000); // huge clip capped
  });

  it("estimates speech length from text at ~14 chars/sec, clamped", () => {
    expect(estimateSpeechMs("")).toBe(0);
    expect(estimateSpeechMs("hi")).toBe(1_500); // floored
    expect(estimateSpeechMs("x".repeat(140))).toBe(10_000); // 140 / 14 × 1000
    expect(estimateSpeechMs("x".repeat(100_000))).toBe(30_000); // capped
  });
});

describe("elevenlabs key pool — roll over when a key runs out of credit", () => {
  const quotaErr = () =>
    new ElevenLabsError(401, '{"detail":{"status":"quota_exceeded","message":"This request exceeds your quota"}}');
  const badKeyErr = () =>
    new ElevenLabsError(401, '{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}');
  const libraryErr = () =>
    new ElevenLabsError(402, '{"detail":{"status":"paid_plan_required","message":"Free users cannot use library voices"}}');
  const rateErr = () =>
    new ElevenLabsError(429, '{"detail":{"status":"too_many_concurrent_requests"}}');

  it("parseKeys splits on commas/whitespace, trims, dedupes, and drops empties", () => {
    expect(parseKeys("a, b\nc  d,,a")).toEqual(["a", "b", "c", "d"]);
    expect(parseKeys("  solo  ")).toEqual(["solo"]);
    expect(parseKeys("")).toEqual([]);
    expect(parseKeys(undefined)).toEqual([]);
  });

  it("isKeyExhausted is true for out-of-credit AND rejected (401) keys, false for plan/transient errors", () => {
    expect(isKeyExhausted(quotaErr())).toBe(true); // out of credit
    expect(isKeyExhausted(badKeyErr())).toBe(true); // typo'd / revoked key — a good key can still work
    expect(isKeyExhausted(libraryErr())).toBe(false); // paywalled voice — every key fails identically
    expect(isKeyExhausted(rateErr())).toBe(false); // transient rate limit
    expect(isKeyExhausted(new Error("network down"))).toBe(false);
  });

  it("KeyPool.retire advances only the active key and is idempotent under concurrency", () => {
    const pool = new KeyPool(["k1", "k2", "k3"]);
    expect(pool.active).toBe("k1");
    expect(pool.retire("k1")).toBe("k2");
    expect(pool.retire("k1")).toBe("k2"); // a second caller reporting k1 does NOT double-advance
    expect(pool.active).toBe("k2");
    expect(pool.retire("k2")).toBe("k3");
    expect(pool.retire("k3")).toBeUndefined(); // pool drained
    expect(pool.active).toBeUndefined();
  });

  it("KeyPool dedupes so a repeated key never wastes a rotation hop", () => {
    expect(new KeyPool(["k1", "k1", "k2"]).size).toBe(2);
  });

  it("rotates to the next key on a quota error, then succeeds", async () => {
    const pool = new KeyPool(["k1", "k2", "k3"]);
    const used: string[] = [];
    const out = await synthWithRotation(pool, async (key) => {
      used.push(key);
      if (key === "k1") throw quotaErr();
      return Buffer.from(`audio-${key}`);
    });
    expect(out.toString()).toBe("audio-k2");
    expect(used).toEqual(["k1", "k2"]); // tried k1, rolled over to k2
    expect(pool.active).toBe("k2"); // k1 retired for the rest of the process
  });

  it("rotates past a rejected (401 invalid) key so one bad key doesn't kill the pool", async () => {
    const pool = new KeyPool(["typo", "good"]);
    const used: string[] = [];
    const out = await synthWithRotation(pool, async (key) => {
      used.push(key);
      if (key === "typo") throw badKeyErr();
      return Buffer.from(`audio-${key}`);
    });
    expect(out.toString()).toBe("audio-good");
    expect(used).toEqual(["typo", "good"]);
    expect(pool.active).toBe("good");
  });

  it("does NOT rotate on a non-credit error (paywalled voice) — the key is preserved", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    const used: string[] = [];
    await expect(
      synthWithRotation(pool, async (key) => {
        used.push(key);
        throw libraryErr();
      }),
    ).rejects.toThrow(/402/);
    expect(used).toEqual(["k1"]); // no rollover — k2 not burned
    expect(pool.active).toBe("k1");
  });

  it("throws the credit error once every key in the pool is exhausted", async () => {
    const pool = new KeyPool(["k1", "k2"]);
    const used: string[] = [];
    await expect(
      synthWithRotation(pool, async (key) => {
        used.push(key);
        throw quotaErr();
      }),
    ).rejects.toThrow(/quota/i);
    expect(used).toEqual(["k1", "k2"]);
    expect(pool.active).toBeUndefined();
  });

  it("a single-key pool surfaces a quota error without rotation (matches old behavior)", async () => {
    const pool = new KeyPool(["only"]);
    await expect(synthWithRotation(pool, async () => { throw quotaErr(); })).rejects.toThrow(/quota/i);
    expect(pool.active).toBeUndefined();
  });
});

describe("createTts — durationMs", () => {
  it("synthesizes once and reports the clip's play length from its byte size", async () => {
    let synthCalls = 0;
    const tts = createTts(
      { ...baseCfg, apiKey: "x" },
      {
        tag: async (i) => i.text,
        synth: async () => {
          synthCalls++;
          return Buffer.alloc(160_000); // 10s at 128 kbps
        },
      },
    );
    expect(await tts.durationMs(line())).toBe(10_000);
    // A second call for the same line reuses the cached audio — no extra synth.
    await tts.durationMs(line());
    expect(synthCalls).toBe(1);
  });
});

describe("createTts — disabled (no key)", () => {
  const tts = createTts(baseCfg);
  it("reports disabled", () => {
    expect(tts.enabled).toBe(false);
    expect(tts.info().enabled).toBe(false);
  });
  it("GET /tts/info answers enabled:false", async () => {
    const r = res();
    expect(await tts.handle(fakeReq("GET", "/tts/info"), r)).toBe(true);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { enabled: boolean }).enabled).toBe(false);
  });
  it("POST /tts is refused with 503", async () => {
    const r = res();
    await tts.handle(fakeReq("POST", "/tts", JSON.stringify(line())), r);
    expect(r.statusCode).toBe(503);
  });
  it("ignores routes it does not own", async () => {
    const r = res();
    expect(await tts.handle(fakeReq("GET", "/status"), r)).toBe(false);
  });
});

describe("createTts — enabled (injected synth + tagger)", () => {
  function build() {
    let synthCalls = 0;
    const tts = createTts(
      { ...baseCfg, apiKey: "x" },
      {
        tag: async (i) => `[serious] ${i.text}`,
        synth: async (text) => {
          synthCalls++;
          await Promise.resolve();
          return Buffer.from(text);
        },
      },
    );
    return { tts, synthCalls: () => synthCalls };
  }

  it("tags then synthesizes, returning audio/mpeg", async () => {
    const { tts } = build();
    const r = res();
    await tts.handle(fakeReq("POST", "/tts", JSON.stringify(line({ text: "hello" }))), r);
    expect(r.statusCode).toBe(200);
    expect(r.headers["Content-Type"]).toBe("audio/mpeg");
    expect(r.text).toBe("[serious] hello"); // tagger output reached synth
  });

  it("sanitizes the tagged line before synthesis — an unrecognized tag never reaches the voice", async () => {
    let synthed = "";
    const tts = createTts(
      { ...baseCfg, apiKey: "x" },
      {
        // A drifting tagger inserts a stage direction v3 would otherwise read out loud.
        tag: async (i) => `[leans in] [nervous] ${i.text} [glances around]`,
        synth: async (text) => {
          synthed = text;
          return Buffer.from(text);
        },
      },
    );
    await tts.getAudio(line({ text: "I think it's Vesper." }));
    expect(synthed).toBe("[nervous] I think it's Vesper."); // foreign tags stripped, recognized kept
    expect(synthed).not.toMatch(/leans in|glances around/);
  });

  it("caches by content — identical lines synthesize once", async () => {
    const { tts, synthCalls } = build();
    await tts.getAudio(line({ text: "same" }));
    await tts.getAudio(line({ text: "same" }));
    expect(synthCalls()).toBe(1);
  });

  it("dedupes concurrent identical requests", async () => {
    const { tts, synthCalls } = build();
    await Promise.all([tts.getAudio(line({ text: "race" })), tts.getAudio(line({ text: "race" }))]);
    expect(synthCalls()).toBe(1);
  });

  it("rejects empty and over-long text", async () => {
    const { tts } = build();
    const empty = res();
    await tts.handle(fakeReq("POST", "/tts", JSON.stringify({ name: "Atlas", text: "   " })), empty);
    expect(empty.statusCode).toBe(400);

    const longTts = createTts({ ...baseCfg, apiKey: "x", maxTextLength: 10 }, { tag: async (i) => i.text, synth: async (t) => Buffer.from(t) });
    const big = res();
    await longTts.handle(fakeReq("POST", "/tts", JSON.stringify(line({ text: "way too many characters" }))), big);
    expect(big.statusCode).toBe(400);
  });

  it("rate-limits past the burst", async () => {
    const tts = createTts(
      { ...baseCfg, apiKey: "x", rateBurst: 2, rateRefillMs: 60_000 },
      { tag: async (i) => i.text, synth: async (t) => Buffer.from(t) },
    );
    const codes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const r = res();
      await tts.handle(fakeReq("POST", "/tts", JSON.stringify(line({ text: `line ${i}` }))), r);
      codes.push(r.statusCode);
    }
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(200);
    expect(codes[2]).toBe(429); // burst of 2 exhausted
  });
});

describe("createTts — NVIDIA NIM tone tagger (real tag path, fetch mocked)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // Drive the REAL llmTaggedText/NIM path (no injected `tag`); only ElevenLabs synth is stubbed.
  function nimTts(reply: string, opts: { ok?: boolean; status?: number } = {}) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
    global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ""),
      });
      return {
        ok: opts.ok ?? true,
        status: opts.status ?? 200,
        json: async () => ({ choices: [{ message: { content: reply } }] }),
        text: async () => reply,
      } as unknown as Response;
    }) as typeof fetch;
    const tts = createTts(
      { ...baseCfg, apiKey: "x", nimApiKey: "nvapi-test", llmModel: "meta/llama-3.3-70b-instruct" },
      { synth: async (t) => Buffer.from(t) },
    );
    return { tts, calls };
  }

  it("hits the OpenAI-compatible NIM endpoint with a Bearer key + chosen model, then synthesizes the parsed reply", async () => {
    const original = "I think Vesper is hiding something.";
    const { tts, calls } = nimTts(`[nervous] ${original}`);
    const audio = await tts.getAudio(line({ text: original }));

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer nvapi-test");
    const sent = JSON.parse(call.body);
    expect(sent.model).toBe("meta/llama-3.3-70b-instruct");
    expect(sent.messages[0].role).toBe("system");
    expect(sent.messages[1].content).toContain(original);
    expect(audio.toString()).toBe(`[nervous] ${original}`); // parsed reply reached synth
  });

  it("falls back to the heuristic when NIM returns a non-2xx", async () => {
    const original = "Why so quiet, Nova?";
    const { tts } = nimTts("ignored", { ok: false, status: 429 });
    const audio = await tts.getAudio(line({ text: original }));
    expect(audio.toString()).toBe(`[curious] ${original}`); // a rate-limit never breaks synthesis
  });

  it("falls back to the heuristic when NIM drifts from the original wording", async () => {
    const original = "I vote for Vesper.";
    const { tts } = nimTts("[curious] Sure! Here's a punchier version.");
    const audio = await tts.getAudio(line({ kind: "vote", text: original }));
    expect(audio.toString()).toBe(`[serious] ${original}`); // drift guard → heuristic vote tag
  });
});
