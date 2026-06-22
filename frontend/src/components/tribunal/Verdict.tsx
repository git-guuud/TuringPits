import { useState } from "react";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import type { Side } from "../../lib/types.js";
import { explorerTx } from "../../lib/contract.js";
import { useCountdown } from "../../lib/useCountdown.js";

function pct(pool: string, other: string): number {
  const a = parseFloat(pool);
  const t = a + parseFloat(other);
  return t > 0 ? Math.round((a / t) * 100) : 0;
}

/** Parimutuel return multiple if this side wins: (total pool) / (side pool). From real pools. */
function mult(side: string, other: string): string {
  const a = parseFloat(side);
  const t = a + parseFloat(other);
  return a > 0 ? `×${(t / a).toFixed(2)}` : "—";
}

function StateBadge({ s }: { s: ViewState }) {
  const preOpen = s.market.state === "OPEN" && !s.market.bettingLive;
  const settledText =
    s.market.outcome === "DRAW"
      ? "Mistrial · stakes returned"
      : s.market.outcome === "VOID"
        ? "No verdict backed · stakes returned"
        : "Verdict settled on-chain";
  const map: Record<string, { text: string; cls: string }> = {
    OPEN: preOpen
      ? { text: "Sealing the record · wagers open shortly", cls: "text-cream-dim" }
      : { text: "Wagers open · bet now", cls: "text-gilt" },
    LOCKED: { text: "Wagers sealed · match running", cls: "text-cream-dim" },
    SETTLED: { text: settledText, cls: "text-acquit border-acquit/40" },
    REFUND: { text: "Match abandoned · stakes refundable", cls: "text-gilt border-gilt/40" },
  };
  const m = map[s.market.state] ?? map.OPEN!;
  return (
    <span className={["mb-4 inline-flex items-center gap-2 rounded-sm border border-line-2 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.16em]", m.cls].join(" ")}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {m.text}
    </span>
  );
}

interface PickProps {
  verdict: string;
  sub: string;
  pool: string;
  other: string;
  accent: string;
  barClass: string;
  selected: boolean;
  winner: boolean;
  open: boolean;
  disabled: boolean;
  /** Pre-bet payout preview: "◈0.010 → ◈0.024" for the current stake, or null. */
  preview: string | null;
  onPick: () => void;
}

function Pick(p: PickProps) {
  return (
    <button
      type="button"
      disabled={!p.open || p.disabled}
      onClick={p.onPick}
      className={[
        "relative mb-2.5 w-full border px-3.5 py-3.5 text-left transition-colors",
        p.selected ? "border-gilt bg-gradient-to-r from-gilt/[0.06] to-transparent" : "border-line",
        p.open && !p.disabled ? "cursor-pointer hover:border-line-2" : "cursor-default opacity-95",
      ].join(" ")}
    >
      {p.winner && (
        <span className="absolute -right-px -top-px bg-acquit px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink">
          Verdict
        </span>
      )}
      <div className="flex items-baseline justify-between">
        <span className={["font-display text-[20px] tracking-[0.12em]", p.accent].join(" ")}>{p.verdict}</span>
        <span className="font-mono text-[17px] text-cream">{mult(p.pool, p.other)}</span>
      </div>
      <div className="mt-0.5 text-[14px] italic text-mute">{p.sub}</div>
      <div className="mt-2 font-mono text-[11.5px] tracking-[0.06em] text-mute">
        staked ◈ {parseFloat(p.pool).toFixed(2)} · {pct(p.pool, p.other)}%
      </div>
      <div className="mt-1.5 h-0.5 bg-line">
        <div className={["h-full", p.barClass].join(" ")} style={{ width: `${pct(p.pool, p.other)}%` }} />
      </div>
      {p.open && p.preview && (
        <div className="mt-2 font-mono text-[11.5px] tracking-[0.04em] text-gilt">
          your {p.preview} if it holds
        </div>
      )}
    </button>
  );
}

export function Verdict({ api }: { api: MatchApi }) {
  const { state: s, connect, placeBet, claim, refund } = api;
  const [amount, setAmount] = useState("0.01");

  const live = s.market.state === "OPEN" && s.market.bettingLive === true;
  const preOpen = s.market.state === "OPEN" && !s.market.bettingLive;
  const open = live; // bets are only accepted on-chain while live
  const countdown = useCountdown(live ? s.market.closesAt : null);
  const closingSoon = countdown != null && countdown.ms <= 15000;
  const settled = s.market.state === "SETTLED";
  const refundMode = s.market.state === "REFUND"; // host never settled → reclaim via refund()
  const outcome = s.market.outcome;
  const winSide = s.market.winningSide;
  const myStake = parseFloat(s.stakes.yes) + parseFloat(s.stakes.no);
  const claimed = s.stakes.claimed;
  const myWinStake = winSide === "YES" ? parseFloat(s.stakes.yes) : winSide === "NO" ? parseFloat(s.stakes.no) : 0;

  const isWin = settled && (outcome === "YES" || outcome === "NO");
  const isRefundOutcome = settled && (outcome === "DRAW" || outcome === "VOID"); // stakes returned via claim()
  const won = isWin && myWinStake > 0 && !claimed;
  const canClaimRefund = isRefundOutcome && myStake > 0 && !claimed;
  const canRefundLiveness = refundMode && myStake > 0 && !claimed; // reclaim via refund()
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending || s.wallet.status === "connecting";

  const projected = (() => {
    if (!won || !winSide) return null;
    const total = parseFloat(s.market.yesPool) + parseFloat(s.market.noPool);
    const wp = winSide === "YES" ? parseFloat(s.market.yesPool) : parseFloat(s.market.noPool);
    return wp > 0 ? ((total * myWinStake) / wp).toFixed(4) : null;
  })();

  // Stake returned on a non-verdict: Draw refunds the stake less the small draw fee; Void (and the
  // liveness refund) return it in full.
  const refundAmount = (() => {
    if (outcome === "DRAW") return (myStake * (10000 - (s.feeBpsDraw ?? 0))) / 10000;
    if (outcome === "VOID" || refundMode) return myStake;
    return 0;
  })().toFixed(4);

  // Pre-bet payout preview: if you add `amount` to a side and it wins, parimutuel pays your share
  // of the whole pot. An estimate — protocol fee aside, like the headline multiplier.
  const preview = (side: Side): string | null => {
    const a = parseFloat(amount);
    if (!open || !(a > 0)) return null;
    const yes = parseFloat(s.market.yesPool);
    const no = parseFloat(s.market.noPool);
    const sidePool = side === "YES" ? yes : no;
    const payout = (a / (sidePool + a)) * (yes + no + a);
    return `◈${a.toFixed(3)} → ◈${payout.toFixed(3)}`;
  };

  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  // Leave a sliver for gas when staking "Max".
  const maxStake = balance != null ? Math.max(0, balance - 0.001) : null;
  const chips: { label: string; value: string }[] = [
    { label: "0.01", value: "0.01" },
    { label: "0.1", value: "0.1" },
    { label: "1", value: "1" },
    ...(maxStake != null && maxStake > 0 ? [{ label: "Max", value: maxStake.toFixed(3) }] : []),
  ];

  const bet = (side: Side) => {
    if (!open || busy) return;
    void placeBet(side, amount);
  };

  return (
    <aside className="panel min-h-0 overflow-y-auto px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Verdict</div>
      <div className="mb-2 font-display text-[23px] leading-tight text-cream">Will the hidden hand walk free?</div>
      <StateBadge s={s} />

      {/* Live betting countdown — turns urgent in the final seconds. */}
      {live && countdown && (
        <div
          className={[
            "mb-4 flex items-baseline justify-between border-l-2 px-3 py-2 transition-colors",
            closingSoon ? "border-convict bg-convict/[0.07]" : "border-gilt bg-gilt/[0.05]",
          ].join(" ")}
        >
          <span className="font-mono text-[12.5px] uppercase tracking-[0.16em] text-mute">
            {closingSoon ? "Closing" : "Wagers close in"}
          </span>
          <span
            className={[
              "font-mono text-[22px] tabular-nums tracking-[0.08em]",
              closingSoon ? "animate-livepulse text-convict" : "text-gilt",
            ].join(" ")}
          >
            {countdown.label}
          </span>
        </div>
      )}

      {(isRefundOutcome || refundMode) && (
        <div className="mb-3 border-l-2 border-gilt/50 bg-gilt/[0.04] px-3 py-2.5 text-[13.5px] italic leading-snug text-cream-dim">
          {outcome === "DRAW"
            ? "The court reached no verdict — a mistrial. Every wager is returned, less a small fee."
            : outcome === "VOID"
              ? "A faction prevailed, but no wager backed it — so the market is void. Every stake is returned in full."
              : "The match was abandoned before settlement. Reclaim your full stake below."}
        </div>
      )}

      <Pick
        verdict="ACQUITTED"
        sub="the Mafia prevails · reaches parity"
        pool={s.market.yesPool}
        other={s.market.noPool}
        accent="text-[#d98a55]"
        barClass="bg-[#d98a55]"
        selected={parseFloat(s.stakes.yes) > 0}
        winner={settled && winSide === "YES"}
        open={open}
        disabled={busy}
        preview={preview("YES")}
        onPick={() => bet("YES")}
      />
      <Pick
        verdict="CONVICTED"
        sub="the Town roots them out"
        pool={s.market.noPool}
        other={s.market.yesPool}
        accent="text-acquit"
        barClass="bg-acquit"
        selected={parseFloat(s.stakes.no) > 0}
        winner={settled && winSide === "NO"}
        open={open}
        disabled={busy}
        preview={preview("NO")}
        onPick={() => bet("NO")}
      />

      {/* stake input + quick-stake chips — visible only while betting is open */}
      {open && (
        <div className="mb-2.5 mt-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">stake ◈</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-24 border border-line bg-ink-2 px-2 py-1.5 font-mono text-[14px] text-cream outline-none focus:border-gilt"
            />
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">0G</span>
            {connected && balance != null && (
              <span className="ml-auto font-mono text-[11px] tracking-[0.06em] text-mute">
                bal {balance.toFixed(3)} 0G
              </span>
            )}
            {!connected && (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy}
                className="ml-auto rounded-sm border border-line-2 px-2.5 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt"
              >
                {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
              </button>
            )}
          </div>
          <div className="mt-2 flex gap-1.5">
            {chips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => setAmount(c.value)}
                className={[
                  "flex-1 rounded-sm border px-2 py-1.5 font-mono text-[12px] tracking-[0.06em] transition-colors",
                  amount === c.value ? "border-gilt text-gilt" : "border-line text-mute hover:border-line-2 hover:text-cream-dim",
                ].join(" ")}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* action / state line */}
      {preOpen ? (
        <div className="mt-2 rounded-sm border border-dashed border-line-2 px-3 py-3 text-center font-mono text-[12.5px] uppercase tracking-[0.16em] text-mute">
          Sealing the record · wagers open shortly
        </div>
      ) : open ? (
        <div className="mt-2 rounded-sm border border-gilt px-3 py-3 text-center font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt">
          {busy
            ? "Confirming on-chain…"
            : parseFloat(s.stakes.yes) + parseFloat(s.stakes.no) > 0
              ? `Wagered ◈ ${(parseFloat(s.stakes.yes) + parseFloat(s.stakes.no)).toFixed(3)} · tap to add`
              : "Tap a verdict to wager"}
        </div>
      ) : s.market.state === "LOCKED" ? (
        <div className="mt-2 rounded-sm border border-dashed border-line-2 px-3 py-3 text-center font-mono text-[12.5px] uppercase tracking-[0.16em] text-mute">
          🔒 Wagers sealed
        </div>
      ) : won ? (
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy}
          className="mt-2 w-full rounded-sm border border-acquit px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
        >
          {busy ? "Claiming…" : `Claim ◈ ${projected ?? "…"}`}
        </button>
      ) : canClaimRefund ? (
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy}
          className="mt-2 w-full rounded-sm border border-gilt px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
        >
          {busy ? "Returning…" : `Reclaim stake ◈ ${refundAmount}`}
        </button>
      ) : canRefundLiveness ? (
        <button
          type="button"
          onClick={() => void refund()}
          disabled={busy}
          className="mt-2 w-full rounded-sm border border-gilt px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
        >
          {busy ? "Returning…" : `Reclaim stake ◈ ${refundAmount}`}
        </button>
      ) : (
        <div className="mt-2 rounded-sm border border-line px-3 py-3 text-center font-mono text-[12.5px] uppercase tracking-[0.16em] text-mute">
          {claimed
            ? isRefundOutcome || refundMode
              ? "Stake returned ✓"
              : "Payout claimed ✓"
            : refundMode
              ? myStake > 0
                ? "Stakes refundable"
                : "Match abandoned · no wager placed"
              : isRefundOutcome
                ? myStake > 0
                  ? "Stake returned ✓"
                  : "No verdict · no wager placed"
                : myWinStake === 0 && myStake > 0
                  ? "Wager did not match the verdict"
                  : "Settled · no wager placed"}
        </div>
      )}

      {s.tx.error && <div className="mt-2 text-center font-mono text-[11px] leading-snug text-convict">{s.tx.error}</div>}

      {/* Receipt: the on-chain proof of the last wager/claim — click through to the explorer. */}
      {s.tx.lastHash && !s.tx.pending && (
        <a
          href={explorerTx(s.tx.lastHash)}
          target="_blank"
          rel="noreferrer"
          className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-acquit transition-colors hover:text-cream"
        >
          ✓ Confirmed on-chain · {s.tx.lastHash.slice(0, 6)}…{s.tx.lastHash.slice(-4)}
          <span aria-hidden>↗</span>
        </a>
      )}

      <div className="mt-2.5 text-center font-mono text-[11px] tracking-[0.06em] text-mute">
        {connected
          ? `${s.wallet.account?.slice(0, 6)}…${s.wallet.account?.slice(-4)}${balance != null ? ` · ${balance.toFixed(3)} 0G` : ""} · 0G Galileo`
          : "connect a wallet to enter the record"}
      </div>
    </aside>
  );
}
