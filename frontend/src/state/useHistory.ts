/**
 * Reads every past battle straight from the contract for the History screen — no WebSocket, no
 * server. Walks [0, nextMatchId) newest-first, and (when a wallet is connected) annotates each
 * battle with the viewer's own stake and what, if anything, is still reclaimable on it. Reading
 * from chain (rather than a local list) means History is correct on any device and survives a
 * cleared browser. Re-scans on an interval and whenever `refreshSignal` changes (e.g. after a claim).
 */
import { useCallback, useEffect, useState } from "react";
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

/** A reclaimable survival side pot the viewer holds on a past battle. */
export interface PropReclaim {
  index: number;
  seat: number;
  /** survival markets never need `enable` — they settle/refund with the parent match. */
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
    /** Reclaimable survival side pots (per seat). Empty/absent when none are outstanding. */
    props?: PropReclaim[];
  };
}

const MAX_ROWS = 60; // newest battles; plenty for a demo, bounds the read fan-out

export function useHistory(account: string | null, refreshSignal: unknown): { rows: HistoryRow[]; loading: boolean } {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const scan = useCallback(async () => {
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

      const out: HistoryRow[] = [];
      for (const id of ids) {
        try {
          const summary = await readMatchSummary(id);
          let mine: HistoryRow["mine"];
          if (account) {
            const st = await readStakesPublic(MARKET_ADDRESS, id, account);
            const yes = parseFloat(st.yes);
            const no = parseFloat(st.no);
            const stake = yes + no;
            // Survival side pots only become claimable once the match is terminal; read them only
            // then to bound the per-row RPC fan-out.
            const props =
              summary.state === "SETTLED" || summary.state === "REFUND"
                ? propReclaimsOf(await readPropPositions(MARKET_ADDRESS, id, account), summary.state)
                : [];
            const hasProps = props.length > 0;
            if (stake > 0 || hasProps) {
              mine = {
                stakeYes: yes,
                stakeNo: no,
                claimed: st.claimed,
                reclaim: stake > 0 ? reclaimOf(summary, yes, no, st.claimed, head) : undefined,
                props: hasProps ? props : undefined,
              };
            }
          }
          out.push({ summary, mine });
        } catch {
          /* skip an unreadable match; the rest still render */
        }
      }
      setRows(out);
    } finally {
      setLoading(false);
    }
  }, [account]);

  useEffect(() => {
    setLoading(true);
    void scan();
    const id = setInterval(() => void scan(), 30000);
    return () => clearInterval(id);
  }, [scan, refreshSignal]);

  return { rows, loading };
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
 * Outstanding survival side pots for the viewer on a terminal match. A SETTLED prop pays the winning
 * side pro-rata (Yes=survived, No=fell), returns the stake on Void, and a REFUND match returns the
 * stake in full. Already-claimed or losing positions are omitted.
 */
function propReclaimsOf(positions: PropPosition[], state: MatchSummary["state"]): PropReclaim[] {
  const out: PropReclaim[] = [];
  for (const p of positions) {
    if (p.claimed) continue;
    const yes = parseFloat(p.stakeYes);
    const no = parseFloat(p.stakeNo);
    const stake = yes + no;
    if (stake <= 0) continue;

    if (state === "REFUND") {
      out.push({ index: p.index, seat: p.seat, kind: "refund", amount: stake.toFixed(4) });
      continue;
    }
    // SETTLED
    if (p.outcome === "YES" || p.outcome === "NO") {
      const win = p.outcome === "YES" ? yes : no;
      if (win <= 0) continue; // backed the wrong side — nothing to collect
      const wp = parseFloat(p.winningPool);
      const np = parseFloat(p.netPot);
      out.push({ index: p.index, seat: p.seat, kind: "win", amount: (wp > 0 ? (np * win) / wp : 0).toFixed(4) });
    } else if (p.outcome === "VOID") {
      out.push({ index: p.index, seat: p.seat, kind: "return", amount: stake.toFixed(4) });
    }
  }
  return out;
}
