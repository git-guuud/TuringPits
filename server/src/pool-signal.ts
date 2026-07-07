/**
 * Pool-push signal — the bridge that makes the betting book update in real time.
 *
 * The orchestrator's background poll (poolTick) is only a BACKSTOP now. Every wager funnels through the
 * gas relayer — session keys hold no native 0G so they MUST relay, and the liquidity bots relay too — so
 * the relayer sees each bet the instant it mines and calls `bump(matchId)`. That nudges the ACTIVE match's
 * registered pusher, which re-reads the pools and broadcasts them, so spectators see the odds move as fast
 * as the bet confirms (~0.5s on 0G) instead of on the next tick.
 *
 * Only one match runs at a time (index.ts runs them back-to-back), so a single active registration is
 * enough. A bump whose matchId doesn't match the active match — a late relay from a just-finished match,
 * a claim/refund on an old match — is a harmless no-op.
 */
export interface PoolSignal {
  /**
   * The running match registers its (debounced) pool pusher. Replaces any prior registration.
   * Returns an unregister fn to call at teardown so a late bump can't push after the match settles.
   */
  register(matchId: number, onBump: () => void): () => void;
  /** The relayer calls this the instant a sponsored bet for `matchId` lands. Nudges the active pusher. */
  bump(matchId: number): void;
}

export function createPoolSignal(): PoolSignal {
  let active: { matchId: number; onBump: () => void } | null = null;
  return {
    register(matchId, onBump) {
      active = { matchId, onBump };
      return () => {
        // Only clear if we're still the active registration — a later match may have taken over.
        if (active?.matchId === matchId) active = null;
      };
    },
    bump(matchId) {
      if (active?.matchId === matchId) active.onBump();
    },
  };
}
