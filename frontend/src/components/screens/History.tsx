import { useEffect, useState } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import { useHistory, type HistoryRow, type PropReclaim, type ReclaimKind } from "../../state/useHistory.js";
import { navigate } from "../../lib/useRoute.js";
import { betTokenAddress, explorerAddress, explorerToken, explorerTx, MARKET_ADDRESS } from "../../lib/contract.js";
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
  return { label: "Wagers open", cls: "text-gilt" };
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
    ["mine", "My wagers", mineRows.length],
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
        <div className="eyebrow mb-2">The record</div>
        <h1 className="font-display text-[40px] font-semibold uppercase leading-none tracking-[0.18em] text-cream">
          Battle History
        </h1>
        <div className="mt-2 font-body text-[15px] italic text-gilt-soft">
          Every battle, read straight from the chain · newest first
        </div>
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
          ✓ Confirmed on-chain · {s.tx.lastHash.slice(0, 6)}…{s.tx.lastHash.slice(-4)} <span aria-hidden>↗</span>
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
            {filter === "claimable" ? "Nothing left to reclaim." : "No wagers of yours on record yet."}{" "}
            <button type="button" onClick={() => setFilter("all")} className="text-gilt underline-offset-2 hover:underline">Show all battles</button>.
          </div>
        ) : (
          <>
            <ul className="flex flex-col gap-px bg-line">
              {pageRows.map((r) => (
                <Row key={r.summary.matchId} row={r} busy={busy} claimable={isClaimable(r)} onEnableRefund={onEnableRefund} onClaimAll={onClaimAll} />
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
        <span className="uppercase tracking-[0.12em] text-mute-2">On-chain ·</span>
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
    </main>
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
}: {
  row: HistoryRow;
  busy: boolean;
  claimable: boolean;
  onEnableRefund: (matchId: number) => void;
  onClaimAll: (matchId: number, idxs: number[], refund: boolean) => void;
}) {
  const { summary: s, mine } = row;
  const v = verdictOf(s);
  const pot = parseFloat(s.pot).toFixed(2);
  const props = mine?.props ?? [];
  // A REFUND battle reclaims via batchRefund; a settled one via batchClaim (pays wins + Void returns).
  const isRefund = s.state === "REFUND";
  const propsTotal = props.reduce((a, p) => a + parseFloat(p.amount), 0);

  return (
    <li className={["panel flex flex-col gap-3 px-5 py-4", claimable ? "border-l-2 border-gilt" : ""].join(" ")}>
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
        </div>

        {/* Match-level action. Abandoned + past deadline → flip to RefundMode first. Otherwise a SINGLE
            "Collect all" sweeps every reclaimable pot on this battle in one batchClaim/batchRefund tx. */}
        {mine?.enable ? (
          <div className="flex-none text-right">
            <button
              type="button"
              onClick={() => onEnableRefund(s.matchId)}
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
              onClick={() => onClaimAll(s.matchId, props.map((p) => p.index), isRefund)}
              disabled={busy}
              className="rounded-sm border border-acquit px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
            >
              {busy ? "Collecting…" : `${isRefund ? "Reclaim all" : "Collect all"} ◈ ${propsTotal.toFixed(2)}`}
            </button>
          </div>
        ) : mine?.participated ? (
          <div className="flex-none text-right">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">Wagered</span>
          </div>
        ) : null}
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
