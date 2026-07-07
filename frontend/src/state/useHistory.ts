/**
 * Reads past battles straight from the contract for the History screen — no WebSocket, no server.
 * Walks [0, nextMatchId) newest-first, and (when a wallet is connected) annotates each battle with
 * the viewer's own stake and what, if anything, is still reclaimable on it. Reading from chain
 * (rather than a local list) means History is correct on any device and survives a cleared browser.
 *
 * A settled/refunded match is immutable on-chain, so we cache it by id and never re-read it: each
 * periodic tick only fetches matches that are new or still live. Crucially, a row is replaced only on
 * a *successful* read — a transient RPC failure keeps the last-known-good row, so battles never blink
 * out of the list (the old "scan from scratch, silently skip failures, replace everything" loop
 * dropped any match whose read happened to fail that pass). A deep refresh (re-read the viewer's claim
 * state) runs on wallet change and after a tx via `refreshSignal`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  currentBlock,
  MARKET_ADDRESS,
  readMatchSummary,
  readNextMatchId,
  readPropPositions,
  type MatchSummary,
} from "../lib/contract.js";
import { propOutcomeOf, propReclaimsOf, type PropOutcome, type PropReclaim } from "../lib/reclaims.js";

// Reclaim types now live in ../lib/reclaims (shared with the live winnings tray); re-exported so the
// History screen's existing imports keep resolving.
export type { PropReclaim, ReclaimKind } from "../lib/reclaims.js";

export interface HistoryRow {
  summary: MatchSummary;
  /** Present when the connected wallet wagered on ANY of this battle's markets (faction + side). */
  mine?: {
    /** The viewer staked something here — drives the "My wagers" lens even when nothing's outstanding. */
    participated: boolean;
    /** Reclaimable pots (faction verdict first, then the side markets). Absent when none are outstanding. */
    props?: PropReclaim[];
    /** Set when the match is abandoned past its deadline: flip it to RefundMode (then reclaim each market). */
    enable?: { amount: string };
    /** The viewer's realized P&L on this battle (staked vs. gross returned). Only on terminal matches. */
    outcome?: PropOutcome;
  };
}

const MAX_ROWS = 60; // newest battles; plenty for a demo, bounds the read fan-out
// One cheap eth_call each → read summaries wide so every battle shows fast.
const SUMMARY_CONCURRENCY = 8;
// How many matches' positions we orchestrate at once. The real RPC pacing is the shared read-gate in
// contract.ts (which also skips zero-pool outcomes), so this only bounds queue depth; anything that
// still fails just retries next scan — the battle is already shown.
const MINE_CONCURRENCY = 4;
const POLL_MS = 30000;

/** SETTLED/REFUND matches are terminal: their summary never changes again on-chain. */
const isTerminal = (s: MatchSummary) => s.state === "SETTLED" || s.state === "REFUND";

/** Cache entry: the battle (summary) plus whether the viewer's position has been successfully read. */
type CachedRow = HistoryRow & { mineResolved: boolean };

export function useHistory(account: string | null, refreshSignal: unknown): { rows: HistoryRow[]; loading: boolean } {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Persistent across scans: the merge target. Only ever updated on a successful read.
  const cacheRef = useRef(new Map<number, CachedRow>());
  const accountRef = useRef<string | null>(account);
  // Single-flight guard: never let an interval tick race a tx-driven deep refresh.
  const inFlightRef = useRef(false);
  const pendingDeepRef = useRef(false);

  // Publish the current cache as the visible list, newest-first.
  const publish = useCallback((ids: number[]) => {
    const cache = cacheRef.current;
    setRows(ids.map((id) => cache.get(id)).filter((r): r is CachedRow => !!r));
  }, []);

  // The viewer's position on one battle: what they wagered across EVERY market (faction + side) and
  // what's still reclaimable. One fan-out over the props (which skips zero-pool outcomes) now covers
  // the headline faction market too. Connected-only, and kept separate from the summary so that when it
  // fails (RPC rate-limit on the prop fan-out) the battle still renders — only the reclaim annotation is
  // deferred to the next scan.
  const readMine = useCallback(
    async (summary: MatchSummary, head: number): Promise<HistoryRow["mine"]> => {
      if (!account) return undefined;
      const id = summary.matchId;
      const positions = await readPropPositions(MARKET_ADDRESS, id, account);
      const participated = positions.some((p) => p.stakes.some((v) => parseFloat(v) > 0));
      if (!participated) return undefined;
      const props = propReclaimsOf(positions, summary.state);
      // Abandoned (Created/Locked, past its deadline, never settled): offer the permissionless flip to
      // RefundMode so the viewer can then reclaim each market they backed. Match-level, not per-market.
      const abandoned = (summary.rawState === 1 || summary.rawState === 2) && head > 0 && head > summary.settlementDeadlineBlock;
      const staked = positions.reduce((a, p) => a + p.stakes.reduce((s, v) => s + parseFloat(v), 0), 0);
      // Realized P&L: only meaningful once the verdict is in (SETTLED pays winners, REFUND returns stakes).
      const outcome = isTerminal(summary) ? propOutcomeOf(positions, summary.state) : undefined;
      return {
        participated,
        props: props.length ? props : undefined,
        enable: abandoned && staked > 0 ? { amount: staked.toFixed(4) } : undefined,
        outcome,
      };
    },
    [account],
  );

  const scanOnce = useCallback(
    async (deep: boolean) => {
      const cache = cacheRef.current;
      try {
        const next = await readNextMatchId();
        const ids: number[] = [];
        for (let i = next - 1; i >= 0 && ids.length < MAX_ROWS; i--) ids.push(i);

        let head = 0;
        try {
          head = await currentBlock();
        } catch {
          /* no head → can't offer the "enable refund" flip this pass */
        }

        // Forget rows that have scrolled out of the visible window so the cache can't grow unbounded.
        const visible = new Set(ids);
        for (const key of [...cache.keys()]) if (!visible.has(key)) cache.delete(key);

        // ── Phase 1 · summaries. The summary *is* the battle, so this must be robust: one cheap call,
        // read wide. Terminal summaries are immutable → reuse. A fresh/live summary marks mine unresolved
        // so phase 2 (re)reads the viewer's position for it.
        const needSummary = ids.filter((id) => {
          const c = cache.get(id);
          return !c || !isTerminal(c.summary); // new, or still OPEN/LOCKED (may have advanced)
        });
        await mapWithConcurrency(needSummary, SUMMARY_CONCURRENCY, async (id) => {
          try {
            const summary = await withRetry(() => readMatchSummary(id));
            cache.set(id, { summary, mine: cache.get(id)?.mine, mineResolved: false });
          } catch {
            /* leave any cached row in place; a brand-new id simply retries next scan */
          }
        });
        publish(ids); // every battle is visible now — connected or not, regardless of phase 2

        // ── Phase 2 · viewer positions (connected only). Best-effort annotation: a failure here never
        // drops the battle, it just leaves mineResolved=false so the next scan retries it.
        if (account) {
          const needMine = ids.filter((id) => {
            const c = cache.get(id);
            if (!c) return false; // no summary → nothing to annotate yet
            if (!c.mineResolved) return true; // never resolved, or summary was just refreshed
            return deep; // already resolved → only re-read after a wallet tx
          });
          await mapWithConcurrency(needMine, MINE_CONCURRENCY, async (id) => {
            const c = cache.get(id);
            if (!c) return;
            try {
              const mine = await withRetry(() => readMine(c.summary, head));
              cache.set(id, { summary: c.summary, mine, mineResolved: true });
              publish(ids); // reclaim buttons pop in as positions resolve
            } catch {
              /* keep mineResolved=false → retried next scan; the battle stays visible meanwhile */
            }
          });
          publish(ids);
        }
      } finally {
        setLoading(false);
      }
    },
    [account, readMine, publish],
  );

  // Single-flight wrapper: coalesce overlapping requests so a tx-driven deep refresh that lands during
  // an in-flight scan still runs (and wins) instead of being dropped.
  const runScan = useCallback(
    async (deep: boolean) => {
      if (inFlightRef.current) {
        pendingDeepRef.current = pendingDeepRef.current || deep;
        return;
      }
      inFlightRef.current = true;
      try {
        await scanOnce(deep);
      } finally {
        inFlightRef.current = false;
        if (pendingDeepRef.current) {
          pendingDeepRef.current = false;
          void runScan(true);
        }
      }
    },
    [scanOnce],
  );

  useEffect(() => {
    // A wallet switch invalidates every cached `mine`; rebuild from scratch and show the loader.
    if (accountRef.current !== account) {
      accountRef.current = account;
      cacheRef.current.clear();
      setRows([]);
    }
    setLoading(cacheRef.current.size === 0);
    void runScan(true); // mount / account / post-tx → deep refresh
    const iv = setInterval(() => void runScan(false), POLL_MS); // tail check: new + live matches only
    return () => clearInterval(iv);
  }, [account, refreshSignal, runScan]);

  return { rows, loading };
}

/** Run `fn` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

/** Retry a read once on a transient RPC failure — recovers the odd dropped call without hammering. */
async function withRetry<T>(fn: () => Promise<T>, tries = 2, delayMs = 400): Promise<T> {
  let last: unknown;
  for (let t = 0; t < tries; t++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (t < tries - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw last;
}

