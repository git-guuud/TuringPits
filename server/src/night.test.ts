import { describe, expect, it } from "vitest";
import { gateTurn, newNightGate } from "./night.js";
import type { PublicGameState, PublicTurn } from "./wire.js";

const seats = (alive: number[], all = [0, 1, 2, 3, 4]): PublicGameState["players"] =>
  all.map((id) => ({ id, alive: alive.includes(id) }));

const state = (phase: "night" | "day", round: number, alive: number[]): PublicGameState => ({
  nonce: "n",
  phase,
  round,
  players: seats(alive),
  winner: null,
});

// A would-be night-actor turn. If any of this reaches the client, the role leaks — the test
// asserts gateTurn NEVER emits a `turn` for a night decision, so these fields can't escape.
const nightTurn = (seat: number, action: string, target: number): PublicTurn => ({
  seat,
  speech: `secret night reasoning by seat ${seat}`,
  decision: { phase: "night", round: 1, player: seat, action, target },
  attestation: { source: "MOCK-local", signerAddress: "0xsigner" },
});

const dayVote = (seat: number, target: number, round: number): PublicTurn => ({
  seat,
  speech: "I vote to convict",
  decision: { phase: "day", round, player: seat, action: "vote", target },
  attestation: { source: "MOCK-local", signerAddress: "0xsigner" },
});

describe("night redaction gate", () => {
  it("never emits a `turn` for any night action, and never leaks actor/action/speech", () => {
    const gate = newNightGate([0, 1, 2, 3, 4]);
    const emitted = [
      // 3 night actors act in seat order; the phase stays "night" until the last one resolves it.
      ...gateTurn(gate, "night", 1, state("night", 1, [0, 1, 2, 3, 4]), nightTurn(0, "kill", 3)),
      ...gateTurn(gate, "night", 1, state("night", 1, [0, 1, 2, 3, 4]), nightTurn(1, "save", 1)),
      // final night action → resolveNight flips state to "day" with seat 3 dead.
      ...gateTurn(gate, "night", 1, state("day", 1, [0, 1, 2, 4]), nightTurn(2, "investigate", 4)),
    ];

    // No `turn` message at all during the night.
    expect(emitted.some((m) => m.type === "turn")).toBe(false);
    // Exactly one nightfall beat, then one dawn beat.
    expect(emitted.filter((m) => m.type === "night")).toHaveLength(1);
    const dawn = emitted.filter((m) => m.type === "dawn");
    expect(dawn).toHaveLength(1);

    // The serialized night stream leaks none of the actors' secret payload: no speech, and no
    // decision action verb ("killed" in the public dawn beat is the death list, not an action).
    const wire = JSON.stringify(emitted);
    expect(wire).not.toContain("secret night reasoning");
    expect(wire).not.toContain("speech");
    expect(wire).not.toContain('"action":"kill"');
    expect(wire).not.toContain('"action":"investigate"');
    expect(wire).not.toContain('"action":"save"');

    // Dawn reports ONLY the public death — and no life was shielded this night.
    expect(dawn[0]).toMatchObject({ type: "dawn", round: 1, killed: [3], saved: 0 });
  });

  it("reports a blocked kill as no death plus an anonymous shielded-life count", () => {
    const gate = newNightGate([0, 1, 2, 3, 4]);
    const out = [
      ...gateTurn(gate, "night", 1, state("night", 1, [0, 1, 2, 3, 4]), nightTurn(0, "kill", 3)),
      // The resolving night action flips to day with NOBODY dead; the engine reports 1 life shielded.
      ...gateTurn(gate, "night", 1, state("day", 1, [0, 1, 2, 3, 4]), nightTurn(1, "save", 3), 1),
    ];
    const dawn = out.find((m) => m.type === "dawn");
    expect(dawn).toMatchObject({ type: "dawn", killed: [], saved: 1 });
    // Anonymity: the shield is a COUNT, never the seat — so the Doctor can't be triangulated.
    expect(typeof (dawn as { saved: unknown }).saved).toBe("number");
  });

  it("passes day votes through as public, attributable turns", () => {
    const gate = newNightGate([0, 1, 2, 3, 4]);
    // night 1 first (sets prevAlive after the kill)
    gateTurn(gate, "night", 1, state("night", 1, [0, 1, 2, 3, 4]), nightTurn(0, "kill", 3));
    gateTurn(gate, "night", 1, state("day", 1, [0, 1, 2, 4]), nightTurn(2, "investigate", 4));

    const vote = dayVote(0, 4, 1);
    const out = gateTurn(gate, "day", 1, state("night", 2, [0, 1, 2]), vote);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "turn", turn: vote });
  });

  it("attributes a night kill that ends the game (no following day) to a dawn beat", () => {
    const gate = newNightGate([0, 1, 2]);
    // 2 alive town + mafia; mafia kills one → parity → game ends at night, but state still flips
    // to day at resolution, so the dawn beat still fires.
    const out = gateTurn(gate, "night", 3, state("day", 3, [0, 1]), nightTurn(0, "kill", 2));
    expect(out.map((m) => m.type)).toEqual(["night", "dawn"]);
    expect(out.find((m) => m.type === "dawn")).toMatchObject({ killed: [2] });
  });
});
