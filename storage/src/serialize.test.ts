import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  decodeJson,
  serializeMatch,
  serializePersonas,
  sha256Hex,
} from "./serialize.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector for 'abc'", () => {
    expect(sha256Hex(utf8("abc"))).toBe(
      "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes the empty input to the known empty digest", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("canonicalJson", () => {
  it("is independent of object key insertion order", () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 9, y: 8 } });
    const b = canonicalJson({ c: { y: 8, z: 9 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("emits compact output with sorted keys", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("serializePersonas", () => {
  const personas = [
    { seat: 0, name: "Ada", blurb: "calm tactician" },
    { seat: 1, name: "Bo", blurb: "loud accuser" },
  ];

  it("round-trips through decodeJson with the personas intact", () => {
    const bytes = serializePersonas(personas);
    const decoded = decodeJson(bytes) as { kind: string; personas: unknown };
    expect(decoded.kind).toBe("turingpits/personas");
    expect(decoded.personas).toEqual(personas);
  });

  it("is deterministic — same personas produce byte-identical output", () => {
    expect(serializePersonas(personas)).toEqual(serializePersonas(personas));
  });
});

describe("serializeMatch", () => {
  const match = {
    winner: "TOWN" as const,
    turns: [
      {
        seat: 2,
        speech: "I think seat 1 is suspicious.",
        structuredDecision: {
          nonce: "n1",
          phase: "day" as const,
          round: 1,
          player: 2,
          action: "vote" as const,
          target: 1,
        },
        attestation: {
          signedText: '{"nonce":"n1","phase":"day","round":1,"player":2,"action":"vote","target":1}',
          signature: "0xdeadbeef",
          signerAddress: "0x83df000000000000000000000000000000000000",
          source: "MOCK-local" as const,
        },
      },
    ],
  };

  it("captures speech, structured decision, and the TEE signature", () => {
    const decoded = decodeJson(serializeMatch(match)) as {
      kind: string;
      winner: string;
      turns: { speech: string; attestation: { signature: string } }[];
    };
    expect(decoded.kind).toBe("turingpits/match");
    expect(decoded.winner).toBe("TOWN");
    expect(decoded.turns[0]!.speech).toBe("I think seat 1 is suspicious.");
    expect(decoded.turns[0]!.attestation.signature).toBe("0xdeadbeef");
  });

  it("is canonical — re-serializing the decoded evidence yields identical bytes", () => {
    const bytes = serializeMatch(match);
    const reserialized = serializeMatch(decodeJson(bytes) as typeof match);
    expect(reserialized).toEqual(bytes);
  });
});
