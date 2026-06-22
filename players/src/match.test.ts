import { describe, it, expect } from "vitest";
import { runMatch } from "@turingpits/engine";
import type { GameState } from "@turingpits/engine";
import { playMatch, privateKnowledge, phaseActors, toSettlementMove } from "./match.js";
import type { RecordedTurn } from "./match.js";
import { Player } from "./player.js";
import { MockLocalProvider } from "./provider.js";
import { verifyAttestation } from "./attestation.js";
import type { InferenceProvider, Persona } from "./types.js";

// Distinct fixed keys are unnecessary — one shared provider models one TEE provider key
// signing every seat's decision, exactly as the on-chain verifier expects.
const PROVIDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SEED = "0x" + "11".repeat(32);
const NONCE = "match-001";

const personas: Persona[] = [
  { seat: 0, name: "Ada", blurb: "an analyst" },
  { seat: 1, name: "Boris", blurb: "a skeptic" },
  { seat: 2, name: "Cleo", blurb: "a peacemaker" },
  { seat: 3, name: "Dmitri", blurb: "a contrarian" },
  { seat: 4, name: "Esme", blurb: "a strategist" },
];

function buildPlayers() {
  const provider = new MockLocalProvider(PROVIDER_KEY);
  return personas.map(() => new Player(provider));
}

function mkState(over: Partial<GameState>): GameState {
  return {
    nonce: "n",
    players: [],
    phase: "day",
    round: 1,
    pending: [],
    investigations: [],
    winner: null,
    ...over,
  };
}

describe("phaseActors", () => {
  // Two Mafia (0, 2), a Doctor (3), a Detective (4), and Town (1). The Mafia kill must never be
  // offered a teammate as a legal target — otherwise the deterministic fallback could team-kill.
  const nightState = mkState({
    phase: "night",
    players: [
      { id: 0, role: "MAFIA", alive: true },
      { id: 1, role: "TOWN", alive: true },
      { id: 2, role: "MAFIA", alive: true },
      { id: 3, role: "DOCTOR", alive: true },
      { id: 4, role: "DETECTIVE", alive: true },
    ],
  });

  it("never offers a Mafia killer a fellow Mafia (or itself) as a legal target", () => {
    for (const seat of [0, 2]) {
      const kill = phaseActors(nightState).find((a) => a.seat === seat && a.action === "kill")!;
      expect(kill.legalTargets).toEqual([1, 3, 4]); // only the Town side
    }
  });

  it("lets the Doctor protect anyone (incl. itself) and the Detective investigate anyone but itself", () => {
    const save = phaseActors(nightState).find((a) => a.action === "save")!;
    expect(save.legalTargets).toEqual([0, 1, 2, 3, 4]);
    const inv = phaseActors(nightState).find((a) => a.action === "investigate")!;
    expect(inv.legalTargets).toEqual([0, 1, 2, 3]); // excludes the detective (seat 4) only
  });

  it("never offers a Mafia a teammate on the DAY vote (no self-elimination), but Town may vote anyone", () => {
    const dayState = mkState({ phase: "day", players: nightState.players });
    const mafiaVote = phaseActors(dayState).find((a) => a.seat === 0)!; // Mafia
    expect(mafiaVote.action).toBe("vote");
    expect(mafiaVote.legalTargets).toEqual([1, 3, 4]); // excludes self (0) and teammate (2)
    const townVote = phaseActors(dayState).find((a) => a.seat === 1)!; // Town
    expect(townVote.legalTargets).toEqual([0, 2, 3, 4]); // everyone but itself
  });
});

describe("privateKnowledge", () => {
  const state = mkState({
    players: [
      { id: 0, role: "MAFIA", alive: true },
      { id: 1, role: "TOWN", alive: true },
      { id: 2, role: "MAFIA", alive: true },
      { id: 3, role: "DETECTIVE", alive: true },
    ],
    investigations: [
      { round: 1, detective: 3, target: 0, faction: "MAFIA" },
      { round: 1, detective: 99, target: 1, faction: "TOWN" }, // a different detective — ignored
    ],
  });

  it("gives a MAFIA seat only its fellow Mafia", () => {
    expect(privateKnowledge(state, [], 0, "MAFIA").teammates).toEqual([2]);
  });

  it("does not give a town role any teammates", () => {
    expect(privateKnowledge(state, [], 1, "TOWN").teammates).toBeUndefined();
  });

  it("gives a DETECTIVE only its own investigation results, with the faction", () => {
    expect(privateKnowledge(state, [], 3, "DETECTIVE").investigations).toEqual([
      { round: 1, target: 0, faction: "MAFIA" },
    ]);
  });

  it("replays a seat its own prior moves as ownHistory", () => {
    const turns = [
      { seat: 3, structuredDecision: { nonce: "n", phase: "night", round: 1, player: 3, action: "investigate", target: 0 } },
      { seat: 1, structuredDecision: { nonce: "n", phase: "night", round: 1, player: 1, action: "vote", target: 0 } },
    ] as unknown as RecordedTurn[];
    expect(privateKnowledge(state, turns, 3, "DETECTIVE").ownHistory).toEqual([
      { round: 1, phase: "night", action: "investigate", target: 0 },
    ]);
  });
});

describe("playMatch (Day 2 exit criteria)", () => {
  it("runs a full attested Mafia match to a declared winner", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    expect(result.winner === "MAFIA" || result.winner === "TOWN").toBe(true);
    expect(result.turns.length).toBeGreaterThan(0);
  });

  it("carries a valid, locally-verifiable attestation on every decision", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    for (const turn of result.turns) {
      expect(verifyAttestation(turn.attestation)).toBe(true);
      // The attestation binds the exact decision bytes the contract reconstructs: mapping to a
      // settlement Move asserts the body slice equals the encoded decision (throws otherwise).
      const move = toSettlementMove(turn);
      expect(move.decision.target).toBe(turn.structuredDecision.target);
    }
  });

  it("captures decisions that the moderator reproduces to the same winner", async () => {
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
    });

    // Feed the captured structured decisions back through the pure moderator: the
    // transcript is internally consistent and replays to the same outcome.
    const decisions = result.turns.map((t) => t.structuredDecision);
    const replay = runMatch(SEED, 5, NONCE, decisions);
    expect(replay.winner).toBe(result.winner);
  });

  it("fires onTurn once per recorded turn, in order, with the post-decision state", async () => {
    const seen: { seat: number; round: number; phase: string }[] = [];
    const result = await playMatch({
      seed: SEED,
      n: 5,
      nonce: NONCE,
      personas,
      players: buildPlayers(),
      onTurn: (turn, state) => {
        seen.push({ seat: turn.seat, round: turn.structuredDecision.round, phase: turn.structuredDecision.phase });
        expect(state.players.some((p) => p.id === turn.seat)).toBe(true);
      },
    });
    expect(seen.length).toBe(result.turns.length);
    expect(seen.map((s) => s.seat)).toEqual(result.turns.map((t) => t.seat));
  });

  it("wires each seat's private knowledge into its reason prompt (7-seat: two Mafia)", async () => {
    const personas7: Persona[] = Array.from({ length: 7 }, (_, i) => ({
      seat: i,
      name: `P${i}`,
      blurb: "a player",
    }));
    const prompts: string[] = [];
    const base = new MockLocalProvider(PROVIDER_KEY);
    const capturing: InferenceProvider = {
      async complete(prompt) {
        prompts.push(prompt);
        return base.complete(prompt);
      },
    };
    await playMatch({
      seed: SEED,
      n: 7,
      nonce: NONCE,
      personas: personas7,
      players: personas7.map(() => new Player(capturing)),
    });

    // A 7-seat game has two Mafia, so a Mafia seat's reason prompt must name its teammate.
    expect(prompts.some((p) => p.includes("Your fellow Mafia"))).toBe(true);
  });

  it("never broadcasts night reasoning into the public transcript (no info leak)", async () => {
    let n = 0;
    // Unique, identifiable text per inference so any leak is detectable: decision echoes the
    // pinned skeleton; the day-only speech → PUBLICSPEECH_k; the reason → PRIVATEREASON_k.
    const respond = (prompt: string): string => {
      if (prompt.startsWith("Transcription task")) {
        return prompt.split("\n").find((l) => l.trimStart().startsWith('{"nonce"'))!.trim();
      }
      if (prompt.includes("You have privately decided to")) return `PUBLICSPEECH_${n++}_`;
      // The reason prompt is the only remaining one carrying a "Legal target(s)…" line; anything
      // else here is a free-form discussion prompt (matched as the default, so it stays robust to
      // task rewording). The legal line names seats as "Ada (seat 0)" or bare "0, 1, 3, 4".
      const legalLine = prompt.match(/Legal target[^:]*:\s*([^\n]+)/);
      if (!legalLine) return `DISCUSSION_${n++}_`;
      const legal = (legalLine[1]!.match(/\d+/g) ?? []).map(Number);
      return `{"target":${legal[0]},"reason":"PRIVATEREASON_${n++}_"}`;
    };
    const prompts: string[] = [];
    const base = new MockLocalProvider(PROVIDER_KEY, respond);
    const capturing: InferenceProvider = {
      async complete(prompt) { prompts.push(prompt); return base.complete(prompt); },
    };
    const result = await playMatch({
      seed: SEED, n: 5, nonce: NONCE, personas,
      players: personas.map(() => new Player(capturing)),
    });

    const nightTurns = result.turns.filter((t) => t.structuredDecision.phase === "night");
    const dayTurns = result.turns.filter((t) => t.structuredDecision.phase === "day");
    expect(nightTurns.length).toBeGreaterThan(0);

    // A night turn carries private reasoning that is NEVER echoed into any prompt.
    for (const t of nightTurns) {
      expect(t.speech).toMatch(/^PRIVATEREASON_/);
      expect(prompts.some((p) => p.includes(t.speech))).toBe(false);
    }
    // Sanity: day speech IS public — at least one day speech reaches a later prompt's transcript.
    expect(dayTurns.some((t) => prompts.some((p) => p.includes(t.speech)))).toBe(true);
  });

  it("is deterministic for a fixed seed and fixed provider key", async () => {
    const a = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    const b = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    expect(b.winner).toBe(a.winner);
    expect(b.turns.length).toBe(a.turns.length);
  });

  it("runs a day as a discussion pass then a vote pass", async () => {
    const discussion: { seat: number; round: number; speech: string }[] = [];
    const votes: { seat: number; round: number }[] = [];
    await playMatch({
      seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers(),
      onDiscussion: (e) => { discussion.push(e); },
      onTurn: (t) => { if (t.structuredDecision.phase === "day") votes.push({ seat: t.seat, round: t.structuredDecision.round }); },
    });
    // Round 1 day: 5 living seats discuss, then 5 vote.
    const round1Discussion = discussion.filter((d) => d.round === 1);
    const round1Votes = votes.filter((v) => v.round === 1);
    // Two-pass day: every living seat both discusses once and votes once.
    expect(round1Discussion.length).toBe(round1Votes.length);
    expect(round1Discussion.length).toBeGreaterThan(0);
    // Every discussion entry carries a non-empty speech and no decision leaks into `turns`.
    expect(round1Discussion.every((d) => d.speech.length > 0)).toBe(true);
  });

  it("keeps discussion speech out of the settlement turns but inside the transcript", async () => {
    const prompts: string[] = [];
    const discussionSpeeches: string[] = [];
    const base = new MockLocalProvider(PROVIDER_KEY);
    const capturingProvider: InferenceProvider = {
      async complete(p, o) { prompts.push(p); return base.complete(p, o); },
    };
    const result = await playMatch({
      seed: SEED, n: 5, nonce: NONCE, personas,
      players: personas.map(() => new Player(capturingProvider)),
      onDiscussion: (e) => { discussionSpeeches.push(e.speech); },
    });
    // Settlement turns are only night + day-vote decisions.
    for (const t of result.turns) {
      expect(["night", "day"]).toContain(t.structuredDecision.phase);
      expect(t.structuredDecision.action === "vote" || t.structuredDecision.phase === "night").toBe(true);
      toSettlementMove(t); // must not throw — every recorded turn is a real signed decision
    }
    // The "inside the transcript" half: discussion speech is public, so at least one
    // discussion line must reach a later prompt's transcript.
    expect(discussionSpeeches.length).toBeGreaterThan(0);
    expect(prompts.some((p) => discussionSpeeches.some((s) => s.length > 0 && p.includes(s)))).toBe(true);
  });
});
