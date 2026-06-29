import { useEffect, useState } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import { useHistory, type HistoryRow, type ReclaimKind } from "../../state/useHistory.js";
import { navigate } from "../../lib/useRoute.js";
import { betTokenAddress, explorerAddress, explorerToken, explorerTx, MARKET_ADDRESS } from "../../lib/contract.js";
import type { MatchSummary } from "../../lib/contract.js";

/** The verdict as the record phrases it (mirrors the Verdict panel's ACQUITTED/CONVICTED framing). */
function verdictOf(s: MatchSummary): { label: string; cls: string } {
  if (s.state === "SETTLED") {
    if (s.outcome === "YES") return { label: "Acquitted", cls: "text-convict" }; // Mafia walked
    if (s.outcome === "NO") return { label: "Convicted", cls: "text-acquit" }; // Town prevailed
    if (s.outcome === "DRAW") return { label: "Mistrial", cls: "text-mute" };
    if (s.outcome === "VOID") return { label: "Void", cls: "text-mute" };
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

/** A row has money/action outstanding: a faction reclaim and/or any unclaimed side pot. */
function isClaimable(r: HistoryRow): boolean {
  return !!r.mine?.reclaim || (r.mine?.props?.length ?? 0) > 0;
}

/** Total CHIP still reclaimable on a battle (faction reclaim + every outstanding side pot). */
function reclaimableTotal(r: HistoryRow): number {
  let a = r.mine?.reclaim ? parseFloat(r.mine.reclaim.amount) : 0;
  for (const p of r.mine?.props ?? []) a += parseFloat(p.amount);
  return a;
}

export function History({ api }: { api: MatchApi }) {
  const s = api.state;
  const { rows, loading } = useHistory(s.wallet.account, s.tx.lastHash);
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending;

  // Surface money you're owed: never make people scan every row for a reclaim button.
  const [claimableOnly, setClaimableOnly] = useState(false);
  const claimableRows = rows.filter(isClaimable);
  const owed = claimableRows.reduce((acc, r) => acc + reclaimableTotal(r), 0);
  const visibleRows = claimableOnly ? claimableRows : rows;

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

  const onReclaim = (matchId: number, kind: ReclaimKind) => {
    if (busy) return;
    if (kind === "refund") void api.refund(matchId);
    else if (kind === "enable") void api.enterRefund(matchId);
    else void api.claim(matchId);
  };

  // Survival side pots claim/refund per seat on a past battle.
  const onReclaimProp = (matchId: number, index: number, kind: "win" | "return" | "refund") => {
    if (busy) return;
    if (kind === "refund") void api.refundProp(index, matchId);
    else void api.claimProp(index, matchId);
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
          <button
            type="button"
            onClick={() => void api.connect()}
            disabled={s.wallet.status === "connecting"}
            className="mt-4 rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
          >
            {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet to see your positions"}
          </button>
        )}
      </header>

      {/* Money you're owed, impossible to miss: total reclaimable across every past battle + a filter. */}
      {connected && claimableRows.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-gilt/40 bg-gilt/[0.05] px-4 py-3">
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gilt">You can reclaim</div>
            <div className="mt-1 font-mono tabular-nums text-cream">
              <span className="text-[16px]">◈ {owed.toFixed(2)}</span>
              <span className="ml-2 text-[12px] text-mute">
                across {claimableRows.length} {claimableRows.length === 1 ? "battle" : "battles"}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setClaimableOnly((v) => !v)}
            className={[
              "rounded-sm border px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors",
              claimableOnly ? "border-gilt bg-gilt text-ink" : "border-gilt text-gilt hover:bg-gilt hover:text-ink",
            ].join(" ")}
          >
            {claimableOnly ? "Show all battles" : "Show claimable only"}
          </button>
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
            Nothing left to reclaim. <button type="button" onClick={() => setClaimableOnly(false)} className="text-gilt underline-offset-2 hover:underline">Show all battles</button>.
          </div>
        ) : (
          <ul className="flex flex-col gap-px bg-line">
            {visibleRows.map((r) => (
              <Row key={r.summary.matchId} row={r} busy={busy} claimable={isClaimable(r)} onReclaim={onReclaim} onReclaimProp={onReclaimProp} />
            ))}
          </ul>
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

function Row({
  row,
  busy,
  claimable,
  onReclaim,
  onReclaimProp,
}: {
  row: HistoryRow;
  busy: boolean;
  claimable: boolean;
  onReclaim: (matchId: number, kind: ReclaimKind) => void;
  onReclaimProp: (matchId: number, index: number, kind: "win" | "return" | "refund") => void;
}) {
  const { summary: s, mine } = row;
  const v = verdictOf(s);
  const pot = (parseFloat(s.yesPool) + parseFloat(s.noPool)).toFixed(2);
  const props = mine?.props ?? [];

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
            {s.playerCount} seats · pot ◈ {pot} ({parseFloat(s.yesPool).toFixed(2)} / {parseFloat(s.noPool).toFixed(2)})
          </div>
        </div>

        {mine && (
          <div className="flex-none text-right">
            {mine.reclaim ? (
              <button
                type="button"
                onClick={() => onReclaim(s.matchId, mine.reclaim!.kind)}
                disabled={busy}
                className="rounded-sm border border-gilt px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
              >
                {busy
                  ? "…"
                  : mine.reclaim.kind === "enable"
                    ? RECLAIM_CTA.enable
                    : `${RECLAIM_CTA[mine.reclaim.kind]} ◈ ${mine.reclaim.amount}`}
              </button>
            ) : (
              <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">
                {mine.claimed ? "Collected ✓" : "Wagered"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Reclaimable side pots on this battle (player-fate per seat + per-round 'voted out', each backed correctly). */}
      {props.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t hairline pt-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">Side pots ·</span>
          {props.map((p) => (
            <button
              key={p.index}
              type="button"
              onClick={() => onReclaimProp(s.matchId, p.index, p.kind)}
              disabled={busy}
              className="rounded-sm border border-acquit px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
            >
              {busy
                ? "…"
                : `${p.market === "ROUND_VOTED_OUT" ? `Round ${p.param} vote` : `Seat ${p.param + 1} · fate`} · ${p.kind === "refund" ? "Refund" : p.kind === "return" ? "Reclaim" : "Claim"} ◈ ${p.amount}`}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
