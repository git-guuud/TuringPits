import { useEffect, useState } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import { useHistory, type HistoryRow, type PropReclaim, type ReclaimKind } from "../../state/useHistory.js";
import { navigate } from "../../lib/useRoute.js";
import { betTokenAddress, explorerAddress, explorerToken, explorerTx, MARKET_ADDRESS } from "../../lib/contract.js";
import { useStorageLink } from "../../lib/useStorageLink.js";
import { LeaderboardDialog, type Collectable } from "../MatchLeaderboard.js";
import type { MatchSummary } from "../../lib/contract.js";

/** The verdict as the record phrases it (from the FACTION prop; mirrors the Verdict panel's framing). */
function verdictOf(s: MatchSummary): { label: string; cls: string } {
  if (s.state === "SETTLED") {
    if (s.factionState === "RESOLVED" && s.factionWinner === 1) return { label: "Acquitted", cls: "text-convict" }; // Mafia walked
    if (s.factionState === "RESOLVED" && s.factionWinner === 0) return { label: "Convicted", cls: "text-acquit" }; // Town prevailed
    if (s.factionState === "VOID") return { label: "Void", cls: "text-mute" }; // mistrial / no wager backed
    return { label: "Settled", cls: "text-mute" };
  }
  if (s.state === "REFUND") return { label: "Abandoned", cls: "text-gilt" };
  if (s.state === "LOCKED") return { label: "In session", cls: "text-gilt" };
  return { label: "Predictions open", cls: "text-gilt" };
}

/** A battle whose final standings exist: SETTLED or REFUND, i.e. terminal on-chain. */
const hasStandings = (s: MatchSummary) => s.state === "SETTLED" || s.state === "REFUND";

/** The battle's headline verdict, phrased for the leaderboard subtitle (mirrors the live popup's). */
function standingsVerdict(s: MatchSummary): string {
  if (s.state === "REFUND") return "Abandoned · stakes returned";
  if (s.factionState === "VOID") return "Mistrial · stakes returned";
  if (s.factionState === "RESOLVED") return s.factionWinner === 1 ? "Mafia acquitted" : "Mafia convicted";
  return "Settled";
}

const RECLAIM_CTA: Record<ReclaimKind, string> = {
  win: "Claim",
  return: "Reclaim",
  refund: "Refund",
  enable: "Enable refund",
};

/** A row has money/action outstanding: an unclaimed pot on any market, or an abandoned-match flip. */
function isClaimable(r: HistoryRow): boolean {
  return !!r.mine?.enable || (r.mine?.props?.length ?? 0) > 0;
}

/** Total CHIP still reclaimable on a battle (every outstanding pot, or the stake awaiting a refund flip). */
function reclaimableTotal(r: HistoryRow): number {
  if (r.mine?.enable) return parseFloat(r.mine.enable.amount);
  let a = 0;
  for (const p of r.mine?.props ?? []) a += parseFloat(p.amount);
  return a;
}

/** A signed CHIP figure coloured by sign: green profit, red loss, muted break-even. */
function NetBadge({ net, className = "" }: { net: number; className?: string }) {
  const cls = net > 0 ? "text-acquit" : net < 0 ? "text-convict" : "text-mute";
  const sign = net > 0 ? "+" : net < 0 ? "−" : "±";
  return (
    <span className={["font-mono font-semibold tabular-nums", cls, className].join(" ")}>
      {sign}◈ {Math.abs(net).toFixed(2)}
    </span>
  );
}

/** Nested lenses on the record — claimable ⊆ mine ⊆ all. One control instead of scanning 60 rows. */
type FilterMode = "all" | "mine" | "claimable";

const PAGE_SIZE = 10; // battles per page — keep the list (and the DOM) to a readable window

export function History({ api }: { api: MatchApi }) {
  const s = api.state;
  const { rows, loading } = useHistory(s.wallet.account, s.tx.lastHash);
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending;

  // Surface money you're owed and let people narrow to their own positions: never make anyone
  // scan every row for a reclaim button or to find what they backed.
  const [filter, setFilter] = useState<FilterMode>("all");
  const mineRows = rows.filter((r) => !!r.mine);
  const claimableRows = rows.filter(isClaimable);
  const owed = claimableRows.reduce((acc, r) => acc + reclaimableTotal(r), 0);
  const visibleRows = filter === "claimable" ? claimableRows : filter === "mine" ? mineRows : rows;

  // Realized P&L across every battle the viewer settled (SETTLED/REFUND). `outcome` is only present once
  // the verdict is in, so live/open wagers don't skew the total — and it counts entitled payouts whether
  // or not they've been collected, so a won-but-unclaimed battle still reads as a win.
  const settledMine = mineRows.filter((r) => r.mine?.outcome);
  const totalStaked = settledMine.reduce((a, r) => a + (r.mine!.outcome!.staked), 0);
  const totalReturned = settledMine.reduce((a, r) => a + (r.mine!.outcome!.returned), 0);
  const netPnl = totalReturned - totalStaked;

  // Page the visible rows so we render 10 at a time, not the whole record. Reset to the first page
  // whenever the lens changes, and clamp so a shrinking list (e.g. after a claim) never strands us
  // past the end.
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter]);
  const pageCount = Math.max(1, Math.ceil(visibleRows.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageStart = clampedPage * PAGE_SIZE;
  const pageRows = visibleRows.slice(pageStart, pageStart + PAGE_SIZE);

  // Only the lenses that hold something: drop "Claimable" when nothing's outstanding.
  const segments: [FilterMode, string, number][] = [
    ["all", "All", rows.length],
    ["mine", "My predictions", mineRows.length],
  ];
  if (claimableRows.length > 0) segments.push(["claimable", "Claimable", claimableRows.length]);

  // The CHIP token is read from the market on-chain; resolve it for the verifiable-source footer.
  const [tokenAddr, setTokenAddr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    betTokenAddress()
      .then((a) => alive && setTokenAddr(a))
      .catch(() => {
        /* token link is best-effort */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Match-level: flip an abandoned, past-deadline match into RefundMode (then each market is refundable).
  const onEnableRefund = (matchId: number) => {
    if (busy) return;
    void api.enterRefund(matchId);
  };

  // Collect every reclaimable pot on a past battle in ONE batch tx — batchClaim for a settled match
  // (pays wins, returns Void stakes), batchRefund for an abandoned one. Replaces per-market claiming.
  const onClaimAll = (matchId: number, idxs: number[], refund: boolean) => {
    if (busy) return;
    void api.claimAllProps(matchId, idxs, refund);
  };

  // Clicking a finished battle opens its final standings — the same leaderboard popup the Live screen
  // shows at match end, read fresh from the chain for that matchId. Only terminal (SETTLED/REFUND)
  // battles have standings; live rows stay non-clickable.
  const [board, setBoard] = useState<HistoryRow | null>(null);
  const boardProps = board?.mine?.props ?? [];
  const boardRefund = board?.summary.state === "REFUND";
  // Anything you can still reclaim on the opened battle powers the dialog's one-tap collect footer.
  const boardWinnings: Collectable | null =
    board && boardProps.length > 0
      ? {
          refund: boardRefund,
          total: boardProps.reduce((a, p) => a + parseFloat(p.amount), 0).toFixed(2),
          count: boardProps.length,
        }
      : null;
  // Same contract as the live popup: collect, then close. A failed tx surfaces in the error banner
  // and the row's own "Collect all" stays available.
  const collectFromBoard = async () => {
    if (!board || busy) return;
    await api.claimAllProps(board.summary.matchId, boardProps.map((p) => p.index), boardRefund);
    setBoard(null);
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[920px] flex-col px-6 py-8">
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={() => navigate("menu")}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-mute transition-colors hover:text-gilt"
        >
          ‹ Lobby
        </button>
        <button
          type="button"
          onClick={() => navigate("live")}
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-mute transition-colors hover:text-gilt"
        >
          Watch live
        </button>
      </div>

      <header className="mt-6 border-b hairline pb-5">
        <h1 className="font-display text-[40px] font-semibold uppercase leading-none tracking-[0.18em] text-cream">
          Battle History
        </h1>
        {!connected && (
          <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
            <button
              type="button"
              onClick={() => void api.connect()}
              disabled={s.wallet.status === "connecting"}
              className="rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
            >
              {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet to see your positions"}
            </button>
            <button
              type="button"
              onClick={() => void api.connectBurner()}
              disabled={s.wallet.status === "connecting"}
              className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute underline decoration-line-2 underline-offset-4 transition-colors hover:text-gilt disabled:opacity-60"
            >
              or play as guest ›
            </button>
          </div>
        )}
      </header>

      {/* Money you're owed, impossible to miss: total reclaimable across every past battle. */}
      {connected && claimableRows.length > 0 && (
        <div className="mt-4 border border-gilt/40 bg-gilt/[0.05] px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gilt">You can reclaim</div>
          <div className="mt-1 font-mono tabular-nums text-cream">
            <span className="text-[16px]">◈ {owed.toFixed(2)}</span>
            <span className="ml-2 text-[12px] text-mute">
              across {claimableRows.length} {claimableRows.length === 1 ? "battle" : "battles"}
            </span>
          </div>
        </div>
      )}

      {/* Realized profit/loss across every battle you've settled — staked vs. what those positions return. */}
      {connected && settledMine.length > 0 && (
        <div className="mt-4 border hairline px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mute-2">
            Your net across the record
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <NetBadge net={netPnl} className="text-[20px]" />
            <span className="font-mono text-[11px] text-mute-2">
              across {settledMine.length} settled {settledMine.length === 1 ? "battle" : "battles"}
            </span>
          </div>
        </div>
      )}

      {/* One lens control: jump straight to your own positions, or just what's still reclaimable. */}
      {connected && mineRows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em]">
          <span className="mr-1 text-mute-2">Show</span>
          {segments.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              className={[
                "rounded-sm border px-3 py-1.5 transition-colors",
                filter === key
                  ? "border-gilt bg-gilt text-ink"
                  : "border-line-2 text-cream-dim hover:border-gilt hover:text-gilt",
              ].join(" ")}
            >
              {label} <span className="opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      {s.tx.error && <div className="mt-3 font-mono text-[11px] text-convict">{s.tx.error}</div>}
      {s.tx.lastHash && !s.tx.pending && (
        <a
          href={explorerTx(s.tx.lastHash)}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-acquit transition-colors hover:text-cream"
        >
          ✓ Confirmed · {s.tx.lastHash.slice(0, 6)}…{s.tx.lastHash.slice(-4)} <span aria-hidden>↗</span>
        </a>
      )}

      <div className="mt-5 flex-1">
        {loading && rows.length === 0 ? (
          <div className="py-16 text-center font-mono text-[12px] uppercase tracking-[0.16em] text-mute">
            Reading the record…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center font-body text-[16px] italic text-mute">
            No battles on record yet. Be the first to <button type="button" onClick={() => navigate("live")} className="text-gilt underline-offset-2 hover:underline">watch one live</button>.
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="py-16 text-center font-body text-[16px] italic text-mute">
            {filter === "claimable" ? "Nothing left to reclaim." : "No predictions of yours on record yet."}{" "}
            <button type="button" onClick={() => setFilter("all")} className="text-gilt underline-offset-2 hover:underline">Show all battles</button>.
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-px bg-line">
              {pageRows.map((r) => (
                <Row
                  key={r.summary.matchId}
                  row={r}
                  busy={busy}
                  claimable={isClaimable(r)}
                  onEnableRefund={onEnableRefund}
                  onClaimAll={onClaimAll}
                  onOpen={hasStandings(r.summary) ? () => setBoard(r) : undefined}
                />
              ))}
            </ul>

            {/* Page through the record 10 at a time — only when there's more than one page. */}
            {visibleRows.length > PAGE_SIZE && (
              <div className="mt-5 flex items-center justify-between font-mono text-[11px] uppercase tracking-[0.14em]">
                <button
                  type="button"
                  onClick={() => setPage(clampedPage - 1)}
                  disabled={clampedPage === 0}
                  className="rounded-sm border border-line-2 px-3 py-1.5 text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-cream-dim"
                >
                  ‹ Prev
                </button>
                <span className="text-mute">
                  {pageStart + 1}–{pageStart + pageRows.length} of {visibleRows.length}
                </span>
                <button
                  type="button"
                  onClick={() => setPage(clampedPage + 1)}
                  disabled={clampedPage >= pageCount - 1}
                  className="rounded-sm border border-line-2 px-3 py-1.5 text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line-2 disabled:hover:text-cream-dim"
                >
                  Next ›
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Verifiable source: the single market every match settles in, and the CHIP stake token. */}
      <footer className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t hairline pt-4 font-mono text-[11px] tracking-[0.06em] text-mute">
        <a
          href={explorerAddress(MARKET_ADDRESS)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 transition-colors hover:text-gilt"
        >
          Market contract <span aria-hidden>↗</span>
        </a>
        {tokenAddr && (
          <a
            href={explorerToken(tokenAddr)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 transition-colors hover:text-gilt"
          >
            CHIP token <span aria-hidden>↗</span>
          </a>
        )}
      </footer>

      {/* Final standings for the clicked battle — every bettor ranked by net P&L (same popup as Live). */}
      <LeaderboardDialog
        open={board != null}
        onClose={() => setBoard(null)}
        matchId={board?.summary.matchId ?? null}
        state={board ? (board.summary.state as "SETTLED" | "REFUND") : null}
        verdict={board ? standingsVerdict(board.summary) : ""}
        account={s.wallet.account}
        winnings={boardWinnings}
        busy={busy}
        onCollect={collectFromBoard}
      />
    </main>
  );
}

/** A bytes32 root is "empty" when unset (all-zero) — the signal that storage was off for this match. */
const isZeroHash = (h?: string) => !h || /^0x0+$/.test(h);
const shortHash = (h: string) => (h.length > 12 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h);

/** A clickable 0G-Storage evidence deep-link (StorageScan file page), sized for a History row. */
function EvidenceRef({ href, label, root }: { href: string; label: string; root: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={root}
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-gilt-soft transition-colors hover:text-gilt"
    >
      {label} <span className="text-mute">{shortHash(root)}</span> <span aria-hidden>↗</span>
    </a>
  );
}

/** The label for a reclaimable pot chip — the market it belongs to. */
function marketLabel(p: PropReclaim): string {
  switch (p.market) {
    case "FACTION": return "Faction verdict";
    case "ROUND_VOTED_OUT": return `Round ${p.param} vote`;
    case "NIGHT_KILL": return `Night ${p.param} kill`;
    case "DETECTIVE_CLAIM": return `Seat ${p.param + 1} · claim`;
    case "MAFIA_SEAT": return "Who is the Mafia?";
    default: return `Seat ${p.param + 1} · fate`;
  }
}

function Row({
  row,
  busy,
  claimable,
  onEnableRefund,
  onClaimAll,
  onOpen,
}: {
  row: HistoryRow;
  busy: boolean;
  claimable: boolean;
  onEnableRefund: (matchId: number) => void;
  onClaimAll: (matchId: number, idxs: number[], refund: boolean) => void;
  /** Present on finished battles: open this battle's final standings (leaderboard popup). */
  onOpen?: () => void;
}) {
  const { summary: s, mine } = row;
  const v = verdictOf(s);
  const pot = parseFloat(s.pot).toFixed(2);
  const props = mine?.props ?? [];
  // 0G Storage evidence (verifiable off-chain via StorageScan). Each root is committed in the on-chain
  // Match struct; a ZeroHash means the host settled with storage disabled, so we render nothing.
  const personaRoot = !isZeroHash(s.personaPoolRoot) ? s.personaPoolRoot! : null;
  const transcriptRoot = !isZeroHash(s.transcriptCID) ? s.transcriptCID! : null;
  const hasEvidence = personaRoot || transcriptRoot;
  // Resolved evidence deep links (indexer file-info immediately, StorageScan page once resolved).
  const transcriptLink = useStorageLink(transcriptRoot ?? "");
  const personaLink = useStorageLink(personaRoot ?? "");
  // A REFUND battle reclaims via batchRefund; a settled one via batchClaim (pays wins + Void returns).
  const isRefund = s.state === "REFUND";
  const propsTotal = props.reduce((a, p) => a + parseFloat(p.amount), 0);

  return (
    <li
      onClick={onOpen}
      onKeyDown={
        onOpen &&
        ((e) => {
          if (e.target !== e.currentTarget) return; // let inner buttons/links keep their own keys
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        })
      }
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      aria-label={onOpen ? `Battle #${s.matchId} — open final standings` : undefined}
      className={[
        "panel flex flex-col gap-3 px-5 py-4",
        claimable ? "border-l-2 border-gilt" : "",
        onOpen ? "group cursor-pointer transition-colors hover:bg-gilt/[0.05]" : "",
      ].join(" ")}
    >
      <div className="flex items-center gap-4">
        <div className="w-16 flex-none">
          <div className="font-mono text-[12px] text-cream">#{s.matchId}</div>
          <div className="font-mono text-[10px] tracking-[0.06em] text-mute">case {s.nonce.slice(-6)}</div>
        </div>

        <div className="flex-1">
          <div className={["font-display text-[20px] tracking-[0.08em]", v.cls].join(" ")}>{v.label}</div>
          <div className="mt-0.5 font-mono text-[11px] tracking-[0.06em] text-mute">
            {s.playerCount} seats · pot ◈ {pot}
          </div>
          {hasEvidence && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tracking-[0.06em]">
              <span className="uppercase tracking-[0.12em] text-mute-2">0G evidence ·</span>
              {transcriptRoot && <EvidenceRef href={transcriptLink} label="transcript" root={transcriptRoot} />}
              {personaRoot && <EvidenceRef href={personaLink} label="personas" root={personaRoot} />}
            </div>
          )}
        </div>

        {/* Match-level action. Abandoned + past deadline → flip to RefundMode first. Otherwise a SINGLE
            "Collect all" sweeps every reclaimable pot on this battle in one batchClaim/batchRefund tx. */}
        {mine?.enable ? (
          <div className="flex-none text-right">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEnableRefund(s.matchId);
              }}
              disabled={busy}
              className="rounded-sm border border-gilt px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
            >
              {busy ? "…" : RECLAIM_CTA.enable}
            </button>
          </div>
        ) : props.length > 0 ? (
          <div className="flex-none text-right">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onClaimAll(s.matchId, props.map((p) => p.index), isRefund);
              }}
              disabled={busy}
              className="rounded-sm border border-acquit px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
            >
              {busy ? "Collecting…" : `${isRefund ? "Reclaim all" : "Collect all"} ◈ ${propsTotal.toFixed(2)}`}
            </button>
          </div>
        ) : mine?.outcome ? (
          <div className="flex-none text-right">
            <NetBadge net={mine.outcome.net} className="text-[24px] leading-none" />
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-mute-2">net</div>
          </div>
        ) : mine?.participated ? (
          <div className="flex-none text-right">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">Staked</span>
          </div>
        ) : null}

        {/* Affordance: a finished battle opens its final standings on click. */}
        {onOpen && (
          <span
            aria-hidden
            className="flex-none font-mono text-[18px] leading-none text-mute-2 transition-colors group-hover:text-gilt"
          >
            ›
          </span>
        )}
      </div>

      {/* Breakdown of what "Collect all" sweeps — the faction verdict first, then each side market you
          backed. Read-only now: one batch tx collects the lot from the button above. */}
      {props.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t hairline pt-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">Your pots ·</span>
          {props.map((p) => (
            <span
              key={p.index}
              className="rounded-sm border border-line-2 px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-cream-dim"
            >
              {marketLabel(p)} · ◈ {p.amount}
            </span>
          ))}
        </div>
      )}
    </li>
  );
}
