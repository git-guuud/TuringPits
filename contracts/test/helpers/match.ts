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
): Promise<{ decisions: EngineDecision[]; mafiaWins: boolean }> {
  const engine = await import("@turingpits/engine");
  let state = engine.initState(seed, n, nonce);
  const decisions: EngineDecision[] = [];
  const doctorSeat = state.players.findIndex((p: any) => p.role === "DOCTOR");

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
      decisions.push(d);
      state = engine.applyDecision(state, d);
      if (engine.winner(state) !== null) break;
    }
  }
  return { decisions, mafiaWins: engine.winner(state) === "MAFIA" };
}

// Map an EngineDecision to the Solidity Decision struct tuple.
export function toSol(d: EngineDecision) {
  const phase = d.phase === "day" ? 1 : 0;
  const action = { kill: 0, save: 1, investigate: 2, vote: 3 }[d.action];
  return { phase, round: d.round, player: d.player, action, target: d.target };
}
