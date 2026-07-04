/**
 * Synchronized in-loop betting windows — the mechanic that turns "a market exists" into "a betting
 * MOMENT". At a dramatic beat the orchestrator PAUSES the stream and spotlights ONE side market for a
 * fixed span; spectators wager against the live pools; then (for the round markets) the prop is frozen
 * on-chain the instant the window closes, BEFORE the outcome is revealed (the vote is cast / dawn breaks).
 *
 * The window is emitted as a `bet_window` beat so the stage plays it in-line with the dialogue (the client
 * counts down to `endsAt`), and the loop actually HOLDS for the duration — that hold is what gives the
 * audience room to bet. Betting itself is still gated on the live market snapshot (`props[].closed`), so
 * `endsAt` is presentation, not a lock; freezing at the close is what prevents last-look on a decided market.
 *
 * This is pure over its injected deps (broadcast / pushPools / freeze / sleep / now) so the emit-order,
 * freeze-timing, and pacing contract is unit-testable without an RPC or a chain (see bet-windows.test.ts).
 */
import type { WsMessage } from "./wire.js";

export type BetWindowMarket = "NIGHT_KILL" | "ROUND_VOTED_OUT" | "DETECTIVE_CLAIM";

export interface BetWindowDeps {
  /** Broadcast a wire message (the `bet_window` beat) to every connected client. */
  broadcast: (msg: WsMessage) => void;
  /** Push the latest pools so the spotlighted market opens on fresh odds. */
  pushPools: () => Promise<void>;
  /** Freeze a prop on-chain; returns whether it actually closed (idempotent — false if already frozen). */
  freeze: (propIdx: number, label: string) => Promise<boolean>;
  /** Sleep for `ms` (injected so tests run instantly and pacing is observable). */
  sleep: (ms: number) => Promise<void>;
  /** Wall clock (injected so tests are deterministic). */
  now: () => number;
}

export interface BetWindowArgs {
  market: BetWindowMarket;
  round: number;
  propIndex: number;
  /** Window length in ms; `<= 0` disables this window (the loop streams straight through). */
  durationMs: number;
  /** Freeze the prop on-chain when the window closes (round markets); false leaves it open (claim market). */
  freezeOnClose: boolean;
  /** DETECTIVE_CLAIM: the seat whose claim the market judges (for client copy). */
  seat?: number;
  /** Stage-pacing cursor: wall-clock at which the PREVIOUS beat finishes playing (from emitPaced). */
  freeAt: number;
}

/**
 * Run ONE betting window and return the updated stage-pacing cursor (`freeAt`). Sequence:
 *   wait out the previous beat → push fresh pools → broadcast the `bet_window` beat (with `endsAt`) →
 *   HOLD for `durationMs` (the real pause) → freeze the prop before its outcome is public (round markets
 *   only) → reset the pacing cursor so the next beat plays at once. A `durationMs <= 0` is a no-op that
 *   leaves `freeAt` untouched (that window is disabled).
 */
export async function runBetWindow(deps: BetWindowDeps, args: BetWindowArgs): Promise<number> {
  const { market, round, propIndex, durationMs, freezeOnClose, seat, freeAt } = args;
  if (durationMs <= 0) return freeAt; // disabled — no pause, no beat

  // Let the previous beat finish on the stage before the window scene appears (same pacing as emitPaced).
  const wait = freeAt - deps.now();
  if (wait > 0) await deps.sleep(wait);

  await deps.pushPools(); // open on the freshest odds
  const endsAt = deps.now() + durationMs;
  deps.broadcast({ type: "bet_window", market, round, propIndex, endsAt, durationMs, seat });

  await deps.sleep(durationMs); // the real pause — the loop holds here so spectators can wager

  if (freezeOnClose) {
    // Freeze BEFORE the outcome is public. Idempotent with the orchestrator's dawn/vote-resolved backstop.
    if (await deps.freeze(propIndex, `${market.toLowerCase()}:r${round}`)) await deps.pushPools();
  }

  return deps.now(); // the next paced beat plays immediately (no leftover hold)
}
