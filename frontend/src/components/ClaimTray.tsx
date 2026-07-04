/**
 * The persistent winnings tray. When a battle the connected wallet backed settles, the match store
 * snapshots its collectable pots (surviving the next round's reducer reset). This surfaces them as a
 * single fixed card with ONE-TAP "Collect all" — a batchClaim (or batchRefund for an abandoned match)
 * that sweeps every winning market in one transaction. It's the fix for two papercuts: claiming each
 * market individually, and losing the Verdict's claim buttons the moment the next round begins.
 *
 * Mounted once in App, alive on every route (the winnings outlive the live screen). Sits just under the
 * TxToaster (z-60) so a claim's confirmation toast cleanly overlays it while the tx is in flight.
 */
import { AnimatePresence, motion } from "framer-motion";
import type { MatchApi } from "../state/matchStore.js";

export function ClaimTray({ api }: { api: MatchApi }) {
  const w = api.winnings;
  const busy = api.state.tx.pending;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[55] flex justify-center px-4">
      <AnimatePresence>
        {w && (
          <motion.div
            key={w.matchId}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
            className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-sm border border-acquit/60 bg-ink-2 px-4 py-3 shadow-xl"
          >
            <span className="shrink-0 text-[20px] leading-none text-gilt" aria-hidden>
              ⚖
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
                {w.refund ? "Stake reclaimable" : "Verdict in your favour"}
              </div>
              <div className="mt-0.5 font-display text-[18px] leading-tight tracking-[0.06em] text-cream">
                <span className="tabular-nums text-acquit">◈ {w.total}</span>
                <span className="ml-1.5 font-mono text-[11px] tracking-[0.06em] text-mute">
                  across {w.count} {w.count === 1 ? "market" : "markets"}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void api.claimAllWinnings()}
              disabled={busy}
              className="shrink-0 rounded-sm border border-acquit px-3 py-2 font-mono text-[11.5px] uppercase tracking-[0.14em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
            >
              {busy ? "Collecting…" : w.refund ? "Reclaim all" : "Collect all"}
            </button>
            <button
              type="button"
              onClick={api.dismissWinnings}
              disabled={busy}
              aria-label="Dismiss (collect later from History)"
              className="shrink-0 font-mono text-[15px] leading-none text-mute transition-colors hover:text-cream disabled:opacity-40"
            >
              ×
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
