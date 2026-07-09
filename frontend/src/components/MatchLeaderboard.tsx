/**
 * Match leaderboard — the popup that lands at match end. Every wallet that wagered on the just-finished
 * battle, named (deterministic pseudonym, or a claimed handle) and ranked by realized net P&L — the same
 * figure the Battle-History screen shows for your own net. Your row is highlighted, and the one-tap
 * "Collect all" lives HERE now (it collects your winnings and closes the board).
 *
 * Data is read straight from the chain (leaderboard.ts → PropBetPlaced logs + per-bettor P&L) with custom
 * handles fetched from the server; both are best-effort, so the board still renders (with pseudonyms) if
 * the name service is down. Auto-opened once per match by the Live screen; also re-openable there.
 *
 * The dialog itself (LeaderboardDialog) is match-agnostic — it takes an explicit matchId + terminal
 * state — so Battle History opens it for any past battle; MatchLeaderboard is the live-match wrapper.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MatchApi } from "../state/matchStore.js";
import { useDialog } from "../lib/useDialog.js";
import { explorerAddress, fetchDisplayNames } from "../lib/contract.js";
import { readMatchLeaderboard, type LeaderRow } from "../lib/leaderboard.js";
import { getLocalName, resolveName, shortAddr } from "../lib/names.js";

/** A signed CHIP figure, coloured by sign (mirrors History's NetBadge). */
function Net({ net, className = "" }: { net: number; className?: string }) {
  const cls = net > 0 ? "text-acquit" : net < 0 ? "text-convict" : "text-mute";
  const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
  return (
    <span className={["font-mono font-semibold tabular-nums", cls, className].join(" ")}>
      {sign}◈{Math.abs(net).toFixed(2)}
    </span>
  );
}

/** What the footer's one-tap collect needs to render — a structural subset of the store's Winnings. */
export interface Collectable {
  /** true → abandoned match, stakes come back via batchRefund; false → settled, batchClaim pays out. */
  refund: boolean;
  /** Total CHIP across every collectable market, formatted. */
  total: string;
  /** How many markets are in the batch — powers "across N markets". */
  count: number;
}

export function MatchLeaderboard({ api, open, onClose }: { api: MatchApi; open: boolean; onClose: () => void }) {
  const s = api.state;
  const matchId = s.matchId;
  const marketState = s.market.state;
  const terminal = marketState === "SETTLED" || marketState === "REFUND";

  // The connected wallet's collectable pots on THIS match (snapshotted by the store at settlement).
  const w = api.winnings && api.winnings.matchId === matchId ? api.winnings : null;
  // Claim, then close — "Close popup on clicking claim all". A failed claim leaves the persistent
  // ClaimTray behind (under the modal) so nothing is stranded.
  const collectAndClose = async () => {
    await api.claimAllWinnings();
    onClose();
  };

  return (
    <LeaderboardDialog
      open={open}
      onClose={onClose}
      matchId={matchId}
      state={terminal ? (marketState as "SETTLED" | "REFUND") : null}
      marketAddress={s.marketAddress ?? undefined}
      verdict={verdictLabel(s)}
      account={s.wallet.account}
      winnings={w}
      busy={s.tx.pending}
      onCollect={collectAndClose}
    />
  );
}

/**
 * The leaderboard modal for ANY terminal match — pass the matchId and its SETTLED/REFUND state and it
 * reads the board itself. `state === null` (match not terminal yet) renders nothing on open, matching
 * the old behaviour of never fetching a live match's board.
 */
export function LeaderboardDialog({
  open,
  onClose,
  matchId,
  state,
  marketAddress,
  verdict,
  account,
  winnings,
  busy,
  onCollect,
}: {
  open: boolean;
  onClose: () => void;
  matchId: number | null;
  state: "SETTLED" | "REFUND" | null;
  marketAddress?: string;
  verdict: string;
  account: string | null;
  winnings: Collectable | null;
  busy: boolean;
  onCollect: () => void;
}) {
  const [rows, setRows] = useState<LeaderRow[] | null>(null);
  const [customNames, setCustomNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  // Read the board (bettors + P&L from chain, custom handles from the server) whenever the popup opens
  // for a terminal match. Race-guarded so a stale fetch can't overwrite a newer one.
  useEffect(() => {
    if (!open || matchId == null || state == null) return;
    let cancelled = false;
    setLoading(true);
    setRows(null);
    void (async () => {
      try {
        const board = await readMatchLeaderboard(matchId, state, marketAddress);
        if (cancelled) return;
        setRows(board);
        const names = await fetchDisplayNames(board.map((r) => r.address));
        if (!cancelled) setCustomNames(names);
      } catch {
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, matchId, state, marketAddress]);

  const nameCtx = { customNames, account, myLocalName: getLocalName(account) };

  return (
    <AnimatePresence>
      {open && (
        <Panel
          onClose={onClose}
          matchId={matchId}
          verdict={verdict}
          rows={rows}
          loading={loading}
          nameCtx={nameCtx}
          winnings={winnings}
          busy={busy}
          onCollect={onCollect}
        />
      )}
    </AnimatePresence>
  );
}

function Panel({
  onClose,
  matchId,
  verdict,
  rows,
  loading,
  nameCtx,
  winnings,
  busy,
  onCollect,
}: {
  onClose: () => void;
  matchId: number | null;
  verdict: string;
  rows: LeaderRow[] | null;
  loading: boolean;
  nameCtx: Parameters<typeof resolveName>[1];
  winnings: Collectable | null;
  busy: boolean;
  onCollect: () => void;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  return (
    <>
      <motion.div
        className="fixed inset-0 z-[58] bg-black/70 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[58] flex items-center justify-center px-4">
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Match leaderboard"
          initial={{ opacity: 0, scale: 0.96, y: 12 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, y: 8 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="panel pointer-events-auto flex max-h-[85dvh] w-full max-w-[520px] flex-col border border-line-2 bg-ink-2 shadow-2xl"
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-4 border-b hairline px-5 py-4">
            <div className="min-w-0">
              <div className="eyebrow mb-1">Final standings</div>
              <h2 className="font-display text-[26px] font-semibold uppercase leading-none tracking-[0.12em] text-cream">
                Leaderboard
              </h2>
              <div className="mt-1.5 font-mono text-[11px] tracking-[0.06em] text-mute">
                {matchId != null ? `Match #${matchId}` : "Match"} · {verdict} · ranked by net P&amp;L
              </div>
            </div>
            <button
              type="button"
              aria-label="Close leaderboard"
              onClick={onClose}
              className="shrink-0 font-mono text-[20px] leading-none text-mute transition-colors hover:text-cream"
            >
              ✕
            </button>
          </div>

          {/* Board */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loading || rows == null ? (
              <div className="py-14 text-center font-mono text-[12px] uppercase tracking-[0.16em] text-mute">
                Tallying the book…
              </div>
            ) : rows.length === 0 ? (
              <div className="py-14 text-center font-body text-[15px] italic text-mute">
                No predictions were placed on this match.
              </div>
            ) : (
              <ul className="flex flex-col">
                {rows.map((r, i) => (
                  <LeaderRowView key={r.address} row={r} rank={i + 1} nameCtx={nameCtx} />
                ))}
              </ul>
            )}
          </div>

          {/* Footer — your winnings collect-all (moved here from the tray). Only when you have something. */}
          {winnings && (
            <div className="border-t hairline px-5 py-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
                    {winnings.refund ? "Your stake is reclaimable" : "Your winnings"}
                  </div>
                  <div className="mt-0.5 font-display text-[19px] leading-none tracking-[0.06em] text-acquit tabular-nums">
                    ◈ {winnings.total}
                    <span className="ml-1.5 font-mono text-[11px] tracking-[0.06em] text-mute">
                      across {winnings.count} {winnings.count === 1 ? "market" : "markets"}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={onCollect}
                  disabled={busy}
                  className="shrink-0 rounded-sm border border-acquit px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
                >
                  {busy ? "Collecting…" : winnings.refund ? "Reclaim all" : "Collect all"}
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </>
  );
}

/** One ranked row: rank, name + short address (linked to the explorer), staked, net. Self is highlighted. */
function LeaderRowView({ row, rank, nameCtx }: { row: LeaderRow; rank: number; nameCtx: Parameters<typeof resolveName>[1] }) {
  const { name, isSelf } = resolveName(row.address, nameCtx);
  return (
    <li
      className={[
        "flex items-center gap-3 rounded-sm px-3 py-2.5 transition-colors",
        isSelf ? "border-l-2 border-gilt bg-gilt/[0.07]" : "border-l-2 border-transparent",
      ].join(" ")}
    >
      {/* rank */}
      <span
        className={[
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border font-mono text-[12px] tabular-nums",
          rank === 1 ? "border-gilt/70 text-gilt" : "border-line-2 text-mute",
        ].join(" ")}
      >
        {rank}
      </span>

      {/* name + address */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-body text-[15px] leading-tight text-cream">{name}</span>
          {isSelf && (
            <span className="shrink-0 rounded-sm border border-gilt/50 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gilt">
              you
            </span>
          )}
        </div>
        <a
          href={explorerAddress(row.address)}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="font-mono text-[10.5px] tracking-[0.06em] text-mute transition-colors hover:text-gilt"
        >
          {shortAddr(row.address)} ↗
        </a>
      </div>

      {/* staked + net */}
      <div className="shrink-0 text-right">
        <Net net={row.net} className="text-[16px]" />
        <div className="mt-0.5 font-mono text-[10px] tracking-[0.04em] text-mute-2 tabular-nums">
          staked ◈{row.staked.toFixed(2)}
        </div>
      </div>
    </li>
  );
}

/** The battle's headline verdict, phrased for the leaderboard subtitle. */
function verdictLabel(s: MatchApi["state"]): string {
  if (s.market.state === "REFUND") return "Abandoned · stakes returned";
  const faction = (s.market.props ?? []).find((p) => p.kind === "FACTION");
  if (faction?.state === "VOID") return "Mistrial · stakes returned";
  if (faction?.state === "RESOLVED") return faction.winningOutcome === 1 ? "Mafia acquitted" : "Mafia convicted";
  return "Settled";
}
