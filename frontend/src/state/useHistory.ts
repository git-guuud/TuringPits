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
  readStakesPublic,
  type MatchSummary,
  type PropPosition,
} from "../lib/contract.js";

export type ReclaimKind = "win" | "return" | "refund" | "enable";

/** A reclaimable side pot (PlayerFate or RoundVotedOut) the viewer holds on a past battle. */
export interface PropReclaim {
  index: number;
  /** PLAYER_FATE: the seat. ROUND_VOTED_OUT: the 1-based day-vote round (for the label). */
  param: number;
  /** Which side market this pot is — drives the History label ("seat N · fate" vs "round R vote"). */
  market: "PLAYER_FATE" | "ROUND_VOTED_OUT";
  /** side markets never need `enable` — they settle/refund with the parent match. */
  kind: "win" | "return" | "refund";
  amount: string;
}

export interface HistoryRow {
  summary: MatchSummary;
  /** Present when the connected wallet wagered on this battle's faction-win OR any survival market. */
  mine?: {
    stakeYes: number;
    stakeNo: number;
    claimed: boolean;
    /** Set when there's still something to collect on the faction market; `enable` flips to RefundMode first. */
    reclaim?: { kind: ReclaimKind; amount: string };
    /** Reclaimable side pots (player-fate + per-round voted-out). Empty/absent when none are outstanding. */
    props?: PropReclaim[];
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

  // The viewer's position on one battle — stake, claim status, and any reclaimable side pots. This is
  // the expensive read (stakes + a fan-out over every side-market prop), and it's *connected-only*.
  // It's kept separate from the summary so that when it fails (RPC rate-limit on the prop fan-out), the
  // battle still renders — only the reclaim annotation is deferred to the next scan.
  const readMine = useCallback(
    async (summary: MatchSummary, head: number): Promise<HistoryRow["mine"]> => {
      if (!account) return undefined;
      const id = summary.matchId;
      const st = await readStakesPublic(MARKET_ADDRESS, id, account);
      const yes = parseFloat(st.yes);
      const no = parseFloat(st.no);
      const stake = yes + no;
      // Survival side pots only become claimable once the match is terminal; read them only then to
      // bound the per-row RPC fan-out.
      const props = isTerminal(summary)
        ? propReclaimsOf(await readPropPositions(MARKET_ADDRESS, id, account), summary.state)
        : [];
      const hasProps = props.length > 0;
      if (stake <= 0 && !hasProps) return undefined;
      return {
        stakeYes: yes,
        stakeNo: no,
        claimed: st.claimed,
        reclaim: stake > 0 ? reclaimOf(summary, yes, no, st.claimed, head) : undefined,
        props: hasProps ? props : undefined,
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

/** What the viewer can still collect on a battle they wagered on, or undefined if nothing. */
function reclaimOf(
  s: MatchSummary,
  yes: number,
  no: number,
  claimed: boolean,
  head: number,
): { kind: ReclaimKind; amount: string } | undefined {
  if (claimed) return undefined;
  const stake = yes + no;
  if (stake <= 0) return undefined;

  if (s.state === "REFUND") return { kind: "refund", amount: stake.toFixed(4) };
  if (s.state === "SETTLED") {
    if (s.outcome === "YES" || s.outcome === "NO") {
      const win = s.outcome === "YES" ? yes : no;
      if (win <= 0) return undefined; // wager lost
      const wp = parseFloat(s.winningPool);
      const np = parseFloat(s.netPot);
      return { kind: "win", amount: (wp > 0 ? (np * win) / wp : 0).toFixed(4) };
    }
    if (s.outcome === "DRAW") return { kind: "return", amount: ((stake * (10000 - s.feeBpsDraw)) / 10000).toFixed(4) };
    if (s.outcome === "VOID") return { kind: "return", amount: stake.toFixed(4) };
    return undefined;
  }
  // Created/Locked, past its deadline, never settled → abandoned; offer the permissionless flip.
  if ((s.rawState === 1 || s.rawState === 2) && head > 0 && head > s.settlementDeadlineBlock) {
    return { kind: "enable", amount: stake.toFixed(4) };
  }
  return undefined;
}

/**
 * Outstanding categorical side pots for the viewer on a terminal match. A SETTLED prop pays the winning
 * outcome's backers pro-rata, returns the stake on Void, and a REFUND match returns the stake in full.
 * Already-claimed or losing positions are omitted.
 */
function propReclaimsOf(positions: PropPosition[], state: MatchSummary["state"]): PropReclaim[] {
  const out: PropReclaim[] = [];
  for (const p of positions) {
    if (p.claimed) continue;
    const total = p.stakes.reduce((s, v) => s + parseFloat(v), 0);
    if (total <= 0) continue;

    if (state === "REFUND") {
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "refund", amount: total.toFixed(4) });
      continue;
    }
    // SETTLED
    if (p.state === "RESOLVED") {
      const win = p.winningOutcome != null ? parseFloat(p.stakes[p.winningOutcome] ?? "0") : 0;
      if (win <= 0) continue; // backed a losing outcome — nothing to collect
      const wp = parseFloat(p.winningPool);
      const np = parseFloat(p.netPot);
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "win", amount: (wp > 0 ? (np * win) / wp : 0).toFixed(4) });
    } else if (p.state === "VOID") {
      out.push({ index: p.index, param: p.param, market: p.kind, kind: "return", amount: total.toFixed(4) });
    }
  }
  return out;
}
