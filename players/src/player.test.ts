import { describe, it, expect } from "vitest";
import { Player } from "./player.js";
import { MockLocalProvider } from "./provider.js";
import { verifyAttestation } from "./attestation.js";
import { toSettlementMove } from "./match.js";
import { claimsDetective } from "./sanitize.js";
import { wrapResponseBody } from "./envelope.js";
import type { Attestation, InferenceProvider, SamplingOptions, TurnContext } from "./types.js";

const FIXED_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const ctx: TurnContext = {
  persona: { seat: 2, name: "Ada", blurb: "an analyst" },
  role: "MAFIA",
  alive: [0, 1, 2, 3, 4],
  transcript: [[0, "seat 3 is quiet"]],
  decisionStub: { nonce: "deadbeef", phase: "day", round: 1, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};

describe("Player.takeTurn", () => {
  it("produces speech, a legal structured decision, and a verifying attestation", async () => {
    const player = new Player(new MockLocalProvider(FIXED_KEY));
    const turn = await player.takeTurn(ctx);

    expect(turn.speech.length).toBeGreaterThan(0);
    expect(turn.structuredDecision.player).toBe(2);
    expect(ctx.legalTargets).toContain(turn.structuredDecision.target);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("at NIGHT makes no public speech — only private reasoning + the signed action", async () => {
    const nightCtx: TurnContext = {
      ...ctx,
      role: "MAFIA",
      decisionStub: { nonce: "deadbeef", phase: "night", round: 1, player: 2, action: "kill" },
      legalTargets: [0, 1, 3, 4],
    };
    let speechCalls = 0;
    const base = new MockLocalProvider(FIXED_KEY);
    const recording: InferenceProvider = {
      async complete(prompt: string) {
        if (prompt.includes("make your in-character case aloud")) speechCalls++;
        return base.complete(prompt);
      },
    };
    const turn = await new Player(recording).takeTurn(nightCtx);

    expect(speechCalls).toBe(0); // the public speak stage is skipped at night
    expect(turn.structuredDecision.action).toBe("kill");
    expect(turn.speech.length).toBeGreaterThan(0); // carries the private reasoning instead
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("binds the decision to the signed body (settlement move maps cleanly)", async () => {
    const player = new Player(new MockLocalProvider(FIXED_KEY));
    const turn = await player.takeTurn(ctx);
    // toSettlementMove asserts the on-chain binding (sliced body bytes == encoded decision)
    // and would throw on any mismatch; the mapped target must match the structured decision.
    const move = toSettlementMove(turn);
    expect(move.decision.target).toBe(turn.structuredDecision.target);
    expect(move.decision.action).toBe(3); // vote
  });

  it("resamples a bad decision inference up to the retry cap, then succeeds", async () => {
    let calls = 0;
    const base = new MockLocalProvider(FIXED_KEY);
    // Fails the first two DECISION inferences (illegal JSON), then defers to the real mock.
    const flaky: InferenceProvider = {
      async complete(prompt: string) {
        if (prompt.startsWith("Transcription task")) {
          calls++;
          if (calls <= 2) {
            const { rawResponseBody, contentOffset, contentLen } = wrapResponseBody("not a decision");
            return {
              text: "not a decision",
              attestation: {
                signature: "0x00",
                signerAddress: "0x0000000000000000000000000000000000000000",
                source: "MOCK-local" as const,
                rawResponseBody,
                contentOffset,
                contentLen,
                reqHashHex: "00".repeat(32),
                providerType: "centralized",
                providerIdentity: "aliyun",
                tlsFingerprint: "sha256/x=",
              },
            };
          }
        }
        return base.complete(prompt);
      },
    };
    const turn = await new Player(flaky, { decisionRetries: 3 }).takeTurn(ctx);
    expect(calls).toBe(3); // two failures + one success
    expect(ctx.legalTargets).toContain(turn.structuredDecision.target);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("makes the structured decision target the seat chosen during the merged vote (speech ⇆ action)", async () => {
    // respond: decision prompt → echo the pinned skeleton; merged day-vote prompt → pick seat 1 + case.
    const respond = (prompt: string): string => {
      if (prompt.startsWith("Transcription task")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("Legal target seats")) {
        return "TARGET: 1\nCASE: Seat 1 keeps deflecting — I am going after them.";
      }
      return "Seat 1 keeps deflecting — I am going after them.";
    };
    const turn = await new Player(new MockLocalProvider(FIXED_KEY, respond)).takeTurn(ctx);

    expect(turn.structuredDecision.target).toBe(1);
    expect(turn.speech).toContain("Seat 1");
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("falls back to a dedicated speech call when the merged vote gives a target but no case", async () => {
    const seen: string[] = [];
    const respond = (prompt: string): string => {
      seen.push(prompt);
      if (prompt.startsWith("Transcription task")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("TARGET: <the seat NUMBER")) return "TARGET: 1"; // legal target, but no CASE
      return "Seat 1 has been dodging every question — they get my vote today."; // the speech fallback
    };
    const turn = await new Player(new MockLocalProvider(FIXED_KEY, respond)).takeTurn(ctx);
    expect(turn.structuredDecision.target).toBe(1);
    expect(turn.speech).toContain("Seat 1"); // the dedicated speech call supplied the case
    expect(seen.filter((p) => p.includes("TARGET: <the seat NUMBER")).length).toBe(1);
    expect(seen.filter((p) => p.includes("You have privately decided to")).length).toBe(1); // fallback fired
  });

  it("falls back to a legal target when the reasoning inference never names one", async () => {
    const respond = (prompt: string): string => {
      if (prompt.startsWith("Transcription task")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("Legal target seats")) return "I honestly cannot decide who to pick.";
      return "Hard to say, but I'll commit.";
    };
    const turn = await new Player(new MockLocalProvider(FIXED_KEY, respond)).takeTurn(ctx);

    // No legal target named → deterministic fallback to the first legal target.
    expect(turn.structuredDecision.target).toBe(ctx.legalTargets[0]);
    expect(verifyAttestation(turn.attestation)).toBe(true);
  });

  it("throws if the provider's decision output is illegal (never silently corrected)", async () => {
    const rogue: InferenceProvider = {
      async complete(prompt: string) {
        const text = prompt.startsWith("Transcription task") ? '{"nonce":"x"}' : "chatter";
        const { rawResponseBody, contentOffset, contentLen } = wrapResponseBody(text);
        const att: Attestation = {
          signature: "0x00",
          signerAddress: "0x0000000000000000000000000000000000000000",
          source: "MOCK-local",
          rawResponseBody,
          contentOffset,
          contentLen,
          reqHashHex: "00".repeat(32),
          providerType: "centralized",
          providerIdentity: "aliyun",
          tlsFingerprint: "sha256/x=",
        };
        return { text, attestation: att };
      },
    };
    await expect(new Player(rogue).takeTurn(ctx)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 2: Per-seat inference diversity
// ---------------------------------------------------------------------------

function capturing(): { provider: InferenceProvider; calls: { prompt: string; opts?: SamplingOptions }[] } {
  const base = new MockLocalProvider("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  const calls: { prompt: string; opts?: SamplingOptions }[] = [];
  return {
    calls,
    provider: { async complete(prompt, opts) { calls.push({ prompt, opts }); return base.complete(prompt, opts); } },
  };
}

function voteCtx(seat: number): TurnContext {
  return {
    persona: { seat, name: `P${seat}`, blurb: "a player" },
    role: "TOWN",
    alive: [0, 1, 2],
    transcript: [],
    decisionStub: { nonce: "n", phase: "day", round: 1, player: seat, action: "vote" },
    legalTargets: [0, 1, 2].filter((i) => i !== seat),
  };
}

describe("Player inference diversity", () => {
  it("passes temperature+seed to non-signed calls but none to the signed decision call", async () => {
    const { provider, calls } = capturing();
    await new Player(provider).takeTurn(voteCtx(0));
    // 2 calls now: the merged vote+speech (sampled), then the signed decision (unsampled). The old
    // separate reason call folded into the merged one.
    expect(calls.length).toBe(2);
    expect(calls[0]!.opts?.temperature).toBeGreaterThan(0); // merged vote+speech
    expect(calls[0]!.opts?.seed).toBeTypeOf("number");      // merged seed present
    expect(calls[1]!.opts).toBeUndefined();                 // signed decision: unchanged request
  });

  it("derives a different seed per seat for the same turn", async () => {
    const a = capturing();
    const b = capturing();
    await new Player(a.provider).takeTurn(voteCtx(0));
    await new Player(b.provider).takeTurn(voteCtx(1));
    expect(a.calls[0]!.opts?.seed).not.toBe(b.calls[0]!.opts?.seed); // merged call carries the per-seat seed
  });
});

describe("Player.discuss", () => {
  it("returns a speech with no structured decision and no attestation", async () => {
    const { provider, calls } = capturing();
    const ctx: TurnContext = { ...voteCtx(0), stage: "discussion" };
    const result = await new Player(provider).discuss(ctx);
    expect(typeof result.speech).toBe("string");
    expect(result.speech.length).toBeGreaterThan(0);
    expect((result as Record<string, unknown>).structuredDecision).toBeUndefined();
    expect((result as Record<string, unknown>).attestation).toBeUndefined();
    // 1 call: discussion speech only — no reason call (no pre-chosen leaning), never a decision.
    expect(calls.length).toBe(1);
  });

  it("keeps a committed read about a player the table is ALREADY debating (not yet spoken)", async () => {
    // Vesper (seat 1) accused Cassius (seat 2); Cassius has NOT spoken. A Town reply that agrees and
    // names Cassius is grounded in Vesper's real line, so the moderator guard must NOT scrub it to a
    // bland fallback. Without the transcript-mention allow-list, Cassius would be a "forbidden name".
    const roster = [
      { seat: 0, name: "Atlas", blurb: "loud" },
      { seat: 1, name: "Vesper", blurb: "dry" },
      { seat: 2, name: "Cassius", blurb: "formal" },
      { seat: 3, name: "Wren", blurb: "steady" },
    ];
    const committed = "I'm with Vesper here — Cassius keeps dodging the real questions, so he has my attention in today's vote.";
    const provider = new MockLocalProvider(FIXED_KEY, () => committed);
    const discCtx: TurnContext = {
      persona: { seat: 3, name: "Wren", blurb: "steady" },
      role: "TOWN",
      alive: [0, 1, 2, 3],
      roster,
      transcript: [[1, "Cassius is all process and no substance — I want a straight answer from him."]],
      decisionStub: { nonce: "n", phase: "day", round: 2, player: 3, action: "vote" },
      legalTargets: [0, 1, 2],
      stage: "discussion",
    };
    const result = await new Player(provider).discuss(discCtx);
    expect(result.speech).toContain("Cassius"); // survived the guard — not collapsed to a fallback
  });

  // A Detective that has privately learned a seat is TOWN must never publicly railroad it. The prompt
  // steers it to vouch, but the weak model ignores that, so the day guard is the reliable layer.
  const detRoster = [
    { seat: 0, name: "Ada", blurb: "cold" },
    { seat: 1, name: "Boris", blurb: "loud" },
    { seat: 2, name: "Cleo", blurb: "calm" },
    { seat: 3, name: "Dmitri", blurb: "dry" },
    { seat: 4, name: "Esme", blurb: "patient" },
  ];
  const detCtx: TurnContext = {
    persona: { seat: 2, name: "Cleo", blurb: "calm" },
    role: "DETECTIVE",
    alive: [0, 1, 2, 3, 4],
    roster: detRoster,
    transcript: [[1, "We're wasting time — somebody commit to a real read already."]],
    decisionStub: { nonce: "n", phase: "day", round: 2, player: 2, action: "vote" },
    legalTargets: [0, 1, 3, 4],
    stage: "discussion",
    investigations: [{ round: 1, target: 4, faction: "TOWN" }], // Cleo privately cleared Esme
  };

  it("never lets a Detective accuse a seat its own investigation has CLEARED (falls back instead)", async () => {
    // The model ignores the vouch task and railroads its cleared seat on every attempt → safe fallback.
    const accuse = "Today's vote should focus on Esme; she's hiding something. Vote her out today.";
    const provider = new MockLocalProvider(FIXED_KEY, () => accuse);
    const result = await new Player(provider).discuss(detCtx);
    expect(result.speech).not.toContain("Esme"); // the cleared seat is never pushed onto the table
    expect(result.speech.length).toBeGreaterThan(0);
  });

  it("lets a Detective VOUCH for its cleared seat while redirecting suspicion (no false reject)", async () => {
    const vouch = "Esme has earned my trust today, so I'm putting the heat on Dmitri instead.";
    const provider = new MockLocalProvider(FIXED_KEY, () => vouch);
    const result = await new Player(provider).discuss(detCtx);
    expect(result.speech).toBe(vouch); // vouching is exactly what a cleared Detective should do
  });

  it("lets a power role RESTATE its own established claim across rounds (own lines aren't echo)", async () => {
    // A Detective who revealed in round 1 must keep pushing the SAME caught-Mafia claim in round 2.
    // The echo guard compares only against OTHER seats, so re-asserting its own line is not parroting
    // and must survive — under the old all-speeches echo check this collapsed to a bland fallback,
    // which is the dominant reason round-2+ speeches were getting filtered out.
    const claim = "I am the Detective. I investigated Boris and Boris is Mafia — vote Boris out today.";
    const revealCtx: TurnContext = {
      persona: { seat: 2, name: "Cleo", blurb: "calm" },
      role: "DETECTIVE",
      alive: [0, 1, 2, 3, 4],
      roster: detRoster,
      // Cleo's OWN round-1 reveal is in the transcript, alongside another seat's line.
      transcript: [
        [2, claim],
        [3, "I still don't have a firm read on anyone here."],
      ],
      decisionStub: { nonce: "n", phase: "day", round: 2, player: 2, action: "vote" },
      legalTargets: [0, 1, 3, 4],
      stage: "discussion",
      investigations: [{ round: 1, target: 1, faction: "MAFIA" }], // caught Boris
    };
    const provider = new MockLocalProvider(FIXED_KEY, () => claim);
    const result = await new Player(provider).discuss(revealCtx);
    expect(result.speech).toContain("I am the Detective");
    expect(result.speech).toContain("Boris"); // survived — not collapsed to a no-name fallback
    // ...and the cleaned reveal is detected as a claim, so the Sequencer floats the "real or bluff?"
    // market on it (task 6.4). Detecting on the guard OUTPUT is what the live path does.
    expect(claimsDetective(result.speech)).toBe(true);
  });

  it("converts a stray 'seat N' in a discussion line to the player's name", async () => {
    const provider = new MockLocalProvider(FIXED_KEY, () => "I have my eye on seat 1 today.");
    const result = await new Player(provider).discuss({ ...detCtx, role: "TOWN", investigations: undefined });
    expect(result.speech).toContain("Boris");   // seat 1 → Boris
    expect(result.speech).not.toContain("seat 1");
  });
});
