import { describe, it, expect } from "vitest";
import { assignRoles, initState, applyDecision, winner, runMatch } from "./moderator.js";
import type { Decision, GameState, Role } from "./types.js";

const SEED = "0x" + "11".repeat(32);
const NONCE = "match-nonce-1";

function tally(roles: readonly Role[]): Record<Role, number> {
  const counts: Record<Role, number> = { MAFIA: 0, DOCTOR: 0, DETECTIVE: 0, TOWN: 0 };
  for (const r of roles) counts[r]++;
  return counts;
}

/** Seat lookups for the (fixed) SEED/n=5 assignment used across the scripted matches. */
function seats(seed: string, n: number) {
  const roles = assignRoles(seed, n);
  const byRole = (role: Role) => roles.flatMap((r, i) => (r === role ? [i] : []));
  return {
    roles,
    mafia: byRole("MAFIA"),
    doctor: byRole("DOCTOR")[0]!,
    detective: byRole("DETECTIVE")[0]!,
    town: byRole("TOWN"),
  };
}

function dec(over: Partial<Decision> & Pick<Decision, "phase" | "round" | "player" | "action" | "target">): Decision {
  return { nonce: NONCE, ...over };
}

describe("assignRoles", () => {
  it("produces the right composition for n=5/6/7/8", () => {
    expect(tally(assignRoles(SEED, 5))).toEqual({ MAFIA: 1, DOCTOR: 1, DETECTIVE: 1, TOWN: 2 });
    expect(tally(assignRoles(SEED, 6))).toEqual({ MAFIA: 1, DOCTOR: 1, DETECTIVE: 1, TOWN: 3 });
    expect(tally(assignRoles(SEED, 7))).toEqual({ MAFIA: 2, DOCTOR: 1, DETECTIVE: 1, TOWN: 3 });
    expect(tally(assignRoles(SEED, 8))).toEqual({ MAFIA: 2, DOCTOR: 1, DETECTIVE: 1, TOWN: 4 });
  });

  it("is deterministic for a given (seed, n)", () => {
    expect(assignRoles(SEED, 6)).toEqual(assignRoles(SEED, 6));
  });

  it("actually shuffles (different seeds give different seatings)", () => {
    expect(assignRoles("0x" + "11".repeat(32), 7)).not.toEqual(assignRoles("0x" + "22".repeat(32), 7));
  });

  it("rejects unsupported player counts", () => {
    expect(() => assignRoles(SEED, 4)).toThrow();
    expect(() => assignRoles(SEED, 9)).toThrow();
  });
});

describe("initState", () => {
  it("sets up a night-1 game with all seats alive and no winner", () => {
    const s = initState(SEED, 5, NONCE);
    expect(s.phase).toBe("night");
    expect(s.round).toBe(1);
    expect(s.players).toHaveLength(5);
    expect(s.players.every((p) => p.alive)).toBe(true);
    expect(s.players.map((p) => p.role)).toEqual(assignRoles(SEED, 5));
    expect(s.winner).toBeNull();
    expect(winner(s)).toBeNull();
  });
});

describe("full matches", () => {
  // TOWN-win: night kill is saved by the doctor, then the town votes out the lone mafia.
  it("settles TOWN when the mafia is voted out (doctor save + detective recorded)", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const m = mafia[0]!;
    const decisions: Decision[] = [
      // Night 1: mafia targets town[0], doctor saves that same seat (kill prevented),
      // detective peeks the mafia.
      dec({ phase: "night", round: 1, player: m, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: town[0]! }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: m }),
      // Day 1: everyone votes the mafia out.
      dec({ phase: "day", round: 1, player: m, action: "vote", target: town[0]! }),
      dec({ phase: "day", round: 1, player: doctor, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: detective, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[0]!, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[1]!, action: "vote", target: m }),
    ];

    const { states, winner: w } = runMatch(SEED, 5, NONCE, decisions);
    expect(w).toBe("TOWN");

    // Two resolutions snapshotted: after night 1 (nobody died — saved) and after day 1.
    expect(states).toHaveLength(2);
    const [afterNight, afterDay] = states;
    expect(afterNight!.phase).toBe("day");
    expect(afterNight!.players.every((p) => p.alive)).toBe(true); // save worked
    expect(afterNight!.investigations).toEqual([
      { round: 1, detective, target: m, faction: "MAFIA" },
    ]);
    expect(afterDay!.players[m]!.alive).toBe(false);
    expect(afterDay!.winner).toBe("TOWN");
  });

  // MAFIA-win: kills land, town misvotes, mafia reaches parity.
  it("settles MAFIA when the mafia reaches parity", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const m = mafia[0]!;
    const decisions: Decision[] = [
      // Night 1: mafia kills town[0]; doctor saves elsewhere; detective peeks.
      dec({ phase: "night", round: 1, player: m, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: doctor }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: m }),
      // Day 1 (alive: m, doctor, detective, town[1]): town misvotes the detective out.
      dec({ phase: "day", round: 1, player: m, action: "vote", target: detective }),
      dec({ phase: "day", round: 1, player: doctor, action: "vote", target: detective }),
      dec({ phase: "day", round: 1, player: detective, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[1]!, action: "vote", target: detective }),
      // Night 2 (alive: m, doctor, town[1]): mafia kills the doctor; doctor saves town[1].
      dec({ phase: "night", round: 2, player: m, action: "kill", target: doctor }),
      dec({ phase: "night", round: 2, player: doctor, action: "save", target: town[1]! }),
      // -> alive: m, town[1] => parity => MAFIA.
    ];

    const { states, winner: w } = runMatch(SEED, 5, NONCE, decisions);
    expect(w).toBe("MAFIA");
    expect(states).toHaveLength(3);
    expect(states[0]!.players[town[0]!]!.alive).toBe(false); // night 1 kill
    expect(states[1]!.players[detective]!.alive).toBe(false); // day 1 misvote
    expect(states[2]!.winner).toBe("MAFIA");
  });
});

describe("resolution rules", () => {
  it("a tied day vote eliminates no one", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const m = mafia[0]!;
    // Get to day 1 with all 5 alive: doctor saves the kill target.
    const toDay: Decision[] = [
      dec({ phase: "night", round: 1, player: m, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: town[0]! }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: m }),
    ];
    // Day 1: 2 votes for town[0], 2 votes for town[1], 1 vote for detective -> no plurality?
    // Make a clean 2–2 tie among the top: votes target[0]x2, target[1]x2, and m votes town[0]
    // -> town[0]:3 ... avoid. Instead: m->detective, doctor->detective, detective->town[0],
    // town[0]->m, town[1]->m  => detective:2, m:2, town[0]:1 -> tie at 2 -> no elimination.
    const tieDay: Decision[] = [
      dec({ phase: "day", round: 1, player: m, action: "vote", target: detective }),
      dec({ phase: "day", round: 1, player: doctor, action: "vote", target: detective }),
      dec({ phase: "day", round: 1, player: detective, action: "vote", target: town[0]! }),
      dec({ phase: "day", round: 1, player: town[0]!, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[1]!, action: "vote", target: m }),
    ];
    const { states } = runMatch(SEED, 5, NONCE, [...toDay, ...tieDay]);
    const afterDay = states[1]!;
    expect(afterDay.phase).toBe("night");
    expect(afterDay.round).toBe(2);
    expect(afterDay.players.every((p) => p.alive)).toBe(true); // tie -> nobody out
  });

  it("a tied mafia kill (two mafia disagree) kills no one", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 7); // 2 mafia
    const [m1, m2] = mafia as [number, number];
    const decisions: Decision[] = [
      dec({ phase: "night", round: 1, player: m1, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: m2, action: "kill", target: town[1]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: doctor }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: m1 }),
    ];
    const { states } = runMatch(SEED, 7, NONCE, decisions);
    expect(states[0]!.players.every((p) => p.alive)).toBe(true); // disagreement -> no kill
  });
});

describe("determinism", () => {
  it("runMatch twice on identical input yields deep-equal states and winner", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const m = mafia[0]!;
    const decisions: Decision[] = [
      dec({ phase: "night", round: 1, player: m, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: town[0]! }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: m }),
      dec({ phase: "day", round: 1, player: m, action: "vote", target: town[0]! }),
      dec({ phase: "day", round: 1, player: doctor, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: detective, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[0]!, action: "vote", target: m }),
      dec({ phase: "day", round: 1, player: town[1]!, action: "vote", target: m }),
    ];
    const a = runMatch(SEED, 5, NONCE, decisions);
    const b = runMatch(SEED, 5, NONCE, decisions);
    expect(a).toEqual(b);
  });
});

describe("applyDecision validation (rejects illegal / out-of-order)", () => {
  const base = (): GameState => initState(SEED, 5, NONCE);
  const s = seats(SEED, 5);
  const m = s.mafia[0]!;

  it("rejects a wrong match nonce", () => {
    expect(() =>
      applyDecision(base(), { ...dec({ phase: "night", round: 1, player: m, action: "kill", target: s.town[0]! }), nonce: "WRONG" }),
    ).toThrow();
  });

  it("rejects a wrong phase (out of order)", () => {
    expect(() =>
      applyDecision(base(), dec({ phase: "day", round: 1, player: m, action: "vote", target: s.town[0]! })),
    ).toThrow();
  });

  it("rejects a wrong round", () => {
    expect(() =>
      applyDecision(base(), dec({ phase: "night", round: 2, player: m, action: "kill", target: s.town[0]! })),
    ).toThrow();
  });

  it("rejects an out-of-range player or target", () => {
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: 99, action: "kill", target: s.town[0]! }))).toThrow();
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: m, action: "kill", target: 99 }))).toThrow();
  });

  it("rejects an action not permitted for the actor's role", () => {
    // A town seat cannot kill.
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: s.town[0]!, action: "kill", target: s.doctor }))).toThrow();
    // A non-doctor cannot save.
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: m, action: "save", target: m }))).toThrow();
    // A non-detective cannot investigate.
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: m, action: "investigate", target: s.doctor }))).toThrow();
  });

  it("rejects an action invalid for the phase", () => {
    // Voting at night.
    expect(() => applyDecision(base(), dec({ phase: "night", round: 1, player: m, action: "vote", target: s.town[0]! }))).toThrow();
  });

  it("rejects a duplicate action by the same player in a phase", () => {
    const after = applyDecision(base(), dec({ phase: "night", round: 1, player: m, action: "kill", target: s.town[0]! }));
    expect(() => applyDecision(after, dec({ phase: "night", round: 1, player: m, action: "kill", target: s.town[1]! }))).toThrow();
  });

  it("rejects acting as a dead player and targeting a dead player", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const mm = mafia[0]!;
    // Run night 1 so town[0] dies (doctor saves elsewhere).
    let state = initState(SEED, 5, NONCE);
    state = applyDecision(state, dec({ phase: "night", round: 1, player: mm, action: "kill", target: town[0]! }));
    state = applyDecision(state, dec({ phase: "night", round: 1, player: doctor, action: "save", target: doctor }));
    state = applyDecision(state, dec({ phase: "night", round: 1, player: detective, action: "investigate", target: mm }));
    expect(state.players[town[0]!]!.alive).toBe(false);
    // Dead player cannot vote.
    expect(() => applyDecision(state, dec({ phase: "day", round: 1, player: town[0]!, action: "vote", target: mm }))).toThrow();
    // Cannot vote a dead player out.
    expect(() => applyDecision(state, dec({ phase: "day", round: 1, player: mm, action: "vote", target: town[0]! }))).toThrow();
  });

  it("rejects any decision after the game is over", () => {
    const { mafia, doctor, detective, town } = seats(SEED, 5);
    const mm = mafia[0]!;
    const { /* won */ } = runMatch(SEED, 5, NONCE, []);
    let state = initState(SEED, 5, NONCE);
    // Quick TOWN win: save the kill, then vote the mafia out.
    for (const d of [
      dec({ phase: "night", round: 1, player: mm, action: "kill", target: town[0]! }),
      dec({ phase: "night", round: 1, player: doctor, action: "save", target: town[0]! }),
      dec({ phase: "night", round: 1, player: detective, action: "investigate", target: mm }),
      dec({ phase: "day", round: 1, player: mm, action: "vote", target: town[0]! }),
      dec({ phase: "day", round: 1, player: doctor, action: "vote", target: mm }),
      dec({ phase: "day", round: 1, player: detective, action: "vote", target: mm }),
      dec({ phase: "day", round: 1, player: town[0]!, action: "vote", target: mm }),
      dec({ phase: "day", round: 1, player: town[1]!, action: "vote", target: mm }),
    ]) {
      state = applyDecision(state, d);
    }
    expect(state.winner).toBe("TOWN");
    expect(() => applyDecision(state, dec({ phase: "night", round: 2, player: doctor, action: "save", target: doctor }))).toThrow();
  });
});
