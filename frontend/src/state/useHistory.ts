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
  readStakesPublic,
  type MatchSummary,
} from "../lib/contract.js";

export type ReclaimKind = "win" | "return" | "refund" | "enable";

export interface HistoryRow {
  summary: MatchSummary;
  /** Present only when the connected wallet actually wagered on this battle. */
  mine?: {
    stakeYes: number;
    stakeNo: number;
    claimed: boolean;
    /** Set when there's still something to collect; `enable` means flip to RefundMode first. */
    reclaim?: { kind: ReclaimKind; amount: string };
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
            if (stake > 0) {
              mine = { stakeYes: yes, stakeNo: no, claimed: st.claimed, reclaim: reclaimOf(summary, yes, no, st.claimed, head) };
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
