// Drives the engine moderator with a full-knowledge, guaranteed-terminating strategy to
// produce a legal ordered decision list and the engine's winner. Used to cross-check the
// Solidity state machine against engine/src/moderator.ts.
export interface EngineDecision {
  nonce: string;
  phase: "night" | "day";
  round: number;
  player: number;
  action: "kill" | "save" | "investigate" | "vote";
  target: number;
}

const NIGHT_ACTION: Record<string, "kill" | "save" | "investigate" | undefined> = {
  MAFIA: "kill", DOCTOR: "save", DETECTIVE: "investigate",
};

export async function scriptedMatch(
  seed: string, n: number, nonce: string,
): Promise<{ decisions: EngineDecision[]; mafiaWins: boolean; alive: boolean[]; firstVotedOut: number | null; votedOutRound: number[]; deathRound: number[] }> {
  const engine = await import("@turingpits/engine");
  let state = engine.initState(seed, n, nonce);
  const decisions: EngineDecision[] = [];
  const doctorSeat = state.players.findIndex((p: any) => p.role === "DOCTOR");

  // The "voted out next" truth: who the round-1 day vote eliminates, if anyone. Captured by watching
  // for an alive→dead transition while applying the round-1 day votes — at that point night kills are
  // already resolved. Subsumed by votedOutRound[seat] (round-1 = the seat whose entry is 1).
  let firstVotedOut: number | null = null;
  // The per-round "voted out" truth: per seat, the 1-based round whose DAY VOTE eliminated it (0 =
  // never voted out — survived or killed at night). Cross-checks g.votedOutRound on-chain. Recorded
  // only for deaths that happen during a DAY phase, so night kills never set it.
  const votedOutRound: number[] = new Array(n).fill(0);
  // The "round of death" truth: per seat, the 1-based round it was eliminated in (0 = survived to the
  // end). Cross-checks g.deathRound on-chain. A death is attributed to the round BEFORE the fatal move
  // is applied — the engine advances `round` only after a day resolves, so the pre-apply round is the
  // true round of any death (night kill or day vote) the move triggers.
  const deathRound: number[] = new Array(n).fill(0);

  let guard = 0;
  while (engine.winner(state) === null) {
    if (guard++ > 200) throw new Error("scripted match did not terminate");
    const living: number[] = state.players.filter((p: any) => p.alive).map((p: any) => p.id);

    for (const p of state.players) {
      if (!p.alive) continue;
      let action: EngineDecision["action"];
      let target: number;
      if (state.phase === "day") {
        action = "vote";
        target = living.find((id) => id !== p.id)!; // lowest-index living seat != self
      } else {
        const a = NIGHT_ACTION[p.role];
        if (!a) continue;
        action = a;
        if (a === "kill") {
          // highest-index living non-mafia, non-doctor (doctor saves itself) -> kill lands.
          const candidates = state.players
            .filter((q: any) => q.alive && q.role !== "MAFIA" && q.id !== doctorSeat)
            .map((q: any) => q.id);
          target = candidates.length ? candidates[candidates.length - 1] : living.find((id) => id !== p.id)!;
        } else if (a === "save") {
          target = p.id; // doctor saves itself
        } else {
          target = living.find((id) => id !== p.id)!; // detective investigates lowest other
        }
      }
      const d: EngineDecision = { nonce, phase: state.phase, round: state.round, player: p.id, action, target };
      // Snapshot the round + alive-set BEFORE applying, so any death this move triggers is detectable
      // and attributable to the correct round. firstVotedOut stays the round-1 day-VOTE casualty only
      // (a night-1 kill is a round-1 death too, but is not "voted out").
      const roundBefore = state.round;
      const isDay = state.phase === "day";
      const aliveById: Record<number, boolean> = {};
      for (const q of state.players as any[]) aliveById[q.id] = q.alive;
      decisions.push(d);
      state = engine.applyDecision(state, d);
      for (const q of state.players as any[]) {
        if (aliveById[q.id] && !q.alive && deathRound[q.id] === 0) {
          deathRound[q.id] = roundBefore;
          // A death during the DAY phase is a vote-out: attribute it to this round's "voted out" band.
          if (isDay) {
            votedOutRound[q.id] = roundBefore;
            if (roundBefore === 1 && firstVotedOut === null) firstVotedOut = q.id;
          }
        }
      }
      if (engine.winner(state) !== null) break;
    }
  }
  // Final survival truth in seat order — the same thing g.alive holds on-chain after settle().
  const alive: boolean[] = [];
  for (let id = 0; id < n; id++) {
    const p = state.players.find((q: any) => q.id === id);
    alive.push(!!p?.alive);
  }
  return { decisions, mafiaWins: engine.winner(state) === "MAFIA", alive, firstVotedOut, votedOutRound, deathRound };
}

// Map an EngineDecision to the Solidity Decision struct tuple.
export function toSol(d: EngineDecision) {
  const phase = d.phase === "day" ? 1 : 0;
  const action = { kill: 0, save: 1, investigate: 2, vote: 3 }[d.action];
  return { phase, round: d.round, player: d.player, action, target: d.target };
}
