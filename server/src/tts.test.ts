import { describe, it, expect } from "vitest";
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
