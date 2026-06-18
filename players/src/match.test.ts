import { describe, it, expect } from "vitest";
import { runMatch } from "@turingpits/engine";
import type { GameState } from "@turingpits/engine";
import { playMatch, privateKnowledge, toSettlementMove } from "./match.js";
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

  it("is deterministic for a fixed seed and fixed provider key", async () => {
    const a = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    const b = await playMatch({ seed: SEED, n: 5, nonce: NONCE, personas, players: buildPlayers() });
    expect(b.winner).toBe(a.winner);
    expect(b.turns.length).toBe(a.turns.length);
  });
});
