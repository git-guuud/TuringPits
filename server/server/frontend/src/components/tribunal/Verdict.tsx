import { useState } from "react";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import type { Side } from "../../lib/types.js";

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
  const map: Record<string, { text: string; cls: string }> = {
    OPEN: { text: "Wagers open · bet now", cls: "text-gilt" },
    LOCKED: { text: "Wagers sealed · match running", cls: "text-cream-dim" },
    SETTLED: { text: "Verdict settled on-chain", cls: "text-acquit border-acquit/40" },
  };
  const m = map[s.market.state] ?? map.OPEN!;
  return (
    <span className={["mb-4 inline-flex items-center gap-2 rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.2em]", m.cls].join(" ")}>
      <span className="h-1 w-1 rounded-full bg-current" />
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
        <span className="absolute -right-px -top-px bg-acquit px-1.5 py-0.5 font-mono text-[8.5px] uppercase tracking-[0.14em] text-ink">
          Verdict
        </span>
      )}
      <div className="flex items-baseline justify-between">
        <span className={["font-display text-[18px] tracking-[0.12em]", p.accent].join(" ")}>{p.verdict}</span>
        <span className="font-mono text-[15px] text-cream">{mult(p.pool, p.other)}</span>
      </div>
      <div className="mt-0.5 text-[12.5px] italic text-mute">{p.sub}</div>
      <div className="mt-2 font-mono text-[10px] tracking-[0.08em] text-mute">
        staked ◈ {parseFloat(p.pool).toFixed(2)} · {pct(p.pool, p.other)}%
      </div>
      <div className="mt-1.5 h-0.5 bg-line">
        <div className={["h-full", p.barClass].join(" ")} style={{ width: `${pct(p.pool, p.other)}%` }} />
      </div>
    </button>
  );
}

export function Verdict({ api }: { api: MatchApi }) {
  const { state: s, connect, placeBet, claim } = api;
  const [amount, setAmount] = useState("0.01");

  const open = s.market.state === "OPEN";
  const settled = s.market.state === "SETTLED";
  const winSide = s.market.winningSide;
  const myWinStake = winSide === "YES" ? parseFloat(s.stakes.yes) : winSide === "NO" ? parseFloat(s.stakes.no) : 0;
  const won = settled && myWinStake > 0 && !s.stakes.claimed;
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending || s.wallet.status === "connecting";

  const projected = (() => {
    if (!won || !winSide) return null;
    const total = parseFloat(s.market.yesPool) + parseFloat(s.market.noPool);
    const wp = winSide === "YES" ? parseFloat(s.market.yesPool) : parseFloat(s.market.noPool);
    return wp > 0 ? ((total * myWinStake) / wp).toFixed(4) : null;
  })();

  const bet = (side: Side) => {
    if (!open || busy) return;
    void placeBet(side, amount);
  };

  return (
    <aside className="panel px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Verdict</div>
      <div className="mb-1 font-display text-[21px] leading-tight text-cream">Will the hidden hand walk free?</div>
      <StateBadge s={s} />

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
        onPick={() => bet("NO")}
      />

      {/* stake input — visible only while betting is open */}
      {open && (
        <div className="mb-2.5 mt-1 flex items-center gap-2">
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-mute">stake ◈</span>
          <input
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-20 border border-line bg-ink-2 px-2 py-1 font-mono text-[12px] text-cream outline-none focus:border-gilt"
          />
          <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-mute">0G</span>
          {!connected && (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy}
              className="ml-auto rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt"
            >
              {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
            </button>
          )}
        </div>
      )}

      {/* action / state line */}
      {open ? (
        <div className="mt-2 rounded-sm border border-gilt px-3 py-3 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-gilt">
          {busy
            ? "Confirming on-chain…"
            : parseFloat(s.stakes.yes) + parseFloat(s.stakes.no) > 0
              ? `Wagered ◈ ${(parseFloat(s.stakes.yes) + parseFloat(s.stakes.no)).toFixed(3)} · tap to add`
              : "Tap a verdict to wager"}
        </div>
      ) : s.market.state === "LOCKED" ? (
        <div className="mt-2 rounded-sm border border-dashed border-line-2 px-3 py-3 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-mute">
          🔒 Wagers sealed
        </div>
      ) : won ? (
        <button
          type="button"
          onClick={() => void claim()}
          disabled={busy}
          className="mt-2 w-full rounded-sm border border-acquit px-3 py-3 font-mono text-[11px] uppercase tracking-[0.18em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
        >
          {busy ? "Claiming…" : `Claim ◈ ${projected ?? "…"}`}
        </button>
      ) : (
        <div className="mt-2 rounded-sm border border-line px-3 py-3 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-mute">
          {s.stakes.claimed
            ? "Payout claimed ✓"
            : myWinStake === 0 && parseFloat(s.stakes.yes) + parseFloat(s.stakes.no) > 0
              ? "Wager did not match the verdict"
              : "Settled · no wager placed"}
        </div>
      )}

      {s.tx.error && <div className="mt-2 text-center font-mono text-[9.5px] leading-snug text-convict">{s.tx.error}</div>}

      <div className="mt-2.5 text-center font-mono text-[9.5px] tracking-[0.1em] text-mute">
        {connected ? `${s.wallet.account?.slice(0, 6)}…${s.wallet.account?.slice(-4)} · 0G Galileo` : "connect a wallet to enter the record"}
      </div>
    </aside>
  );
}
