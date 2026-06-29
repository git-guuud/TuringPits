import { describe, it, expect } from "vitest";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createTts, heuristicTaggedText, type ToneInput } from "./tts.js";
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
        tag: async (i) => `[t]${i.text}`,
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
    expect(r.text).toBe("[t]hello"); // tagger output reached synth
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
