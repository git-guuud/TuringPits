import { useEffect, useState } from "react";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import type { Outcome, Side } from "../../lib/types.js";
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

/** Parimutuel payout for staking `a` on a side: its share of the whole pot if it wins. */
function projectWin(a: number, sidePool: string, otherPool: string): number | null {
  if (!(a > 0)) return null;
  const s = parseFloat(sidePool);
  const o = parseFloat(otherPool);
  return (a / (s + a)) * (s + o + a);
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

// ── one side of a market ──────────────────────────────────────────────────────
interface Choice {
  side: Side;
  /** Small label above the verdict word — the faction or survival framing. */
  eyebrow: string;
  eyebrowClass: string;
  /** The big display word for this outcome. */
  label: string;
  /** Plain-language meaning, one line. */
  sub: string;
  accent: string;
  bar: string;
  pool: string;
  other: string;
  /** The connected wallet's stake already on this side. */
  mine: number;
  /** This outcome is how the market resolved. */
  winner: boolean;
}

function ChoiceCard({
  c,
  selected,
  selectable,
  dimmed,
  onSelect,
}: {
  c: Choice;
  selected: boolean;
  selectable: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={[
        "relative w-full border px-3.5 py-3 text-left transition-colors",
        selected
          ? "border-gilt bg-gilt/[0.06]"
          : c.mine > 0
            ? "border-line-2"
            : c.winner
              ? c.accent.replace("text-", "border-")
              : "border-line",
        selectable ? "cursor-pointer hover:border-line-2" : "cursor-default",
        dimmed ? "opacity-40" : "",
      ].join(" ")}
    >
      {c.winner && (
        <span className="absolute -right-px -top-px bg-acquit px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink">
          Outcome
        </span>
      )}
      {selected && !c.winner && (
        <span className="absolute -right-px -top-px bg-gilt px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-ink">
          ✓ Picked
        </span>
      )}
      <div className="flex items-center justify-between">
        <span className={["font-mono text-[10px] uppercase tracking-[0.14em]", c.eyebrowClass].join(" ")}>{c.eyebrow}</span>
        <span className="font-mono text-[15px] tabular-nums text-cream">{mult(c.pool, c.other)}</span>
      </div>
      <div className={["mt-1.5 font-display text-[21px] tracking-[0.1em]", c.accent].join(" ")}>{c.label}</div>
      <div className="mt-0.5 text-[13px] italic text-mute">{c.sub}</div>
      <div className="mt-2.5 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.06em] text-mute">
        <span>{pct(c.pool, c.other)}% of the pot backs this</span>
        <span>◈ {parseFloat(c.pool).toFixed(2)}</span>
      </div>
      <div className="mt-1.5 h-0.5 bg-line">
        <div className={["h-full", c.bar].join(" ")} style={{ width: `${pct(c.pool, c.other)}%` }} />
      </div>
      {c.mine > 0 && (
        <div className="mt-2 font-mono text-[10.5px] tracking-[0.06em] text-gilt">● your wager · ◈ {c.mine.toFixed(3)}</div>
      )}
    </button>
  );
}

// ── normalized market view-model (faction verdict + one per seat) ──────────────
interface BetMarket {
  key: string;
  title: string;
  question: string;
  choices: [Choice, Choice];
  /** Open and accepting bets (the seat hasn't fallen / been frozen). */
  bettable: boolean;
  /** The wallet already holds a stake somewhere in this market. */
  hasWager: boolean;
  /** A claim/refund is available right now. */
  canClaim: boolean;
  claimLabel: string;
  doClaim: () => void;
  place: (side: Side) => void;
  /** Shown in the footer when the market is neither bettable nor claimable. */
  status: string | null;
}

export function Verdict({ api }: { api: MatchApi }) {
  const { state: s, connect, placeBet, placePropBet, claim, claimProp, refund, refundProp } = api;
  const [amount, setAmount] = useState("0.01");
  const [index, setIndex] = useState(0);
  const [picked, setPicked] = useState<Side | null>(null);

  const live = s.market.state === "OPEN" && s.market.bettingLive === true;
  const preOpen = s.market.state === "OPEN" && !s.market.bettingLive;
  const open = live; // bets are only accepted on-chain while live
  const countdown = useCountdown(live ? s.market.closesAt : null);
  const closingSoon = countdown != null && countdown.ms <= 15000;
  const settled = s.market.state === "SETTLED";
  const refundMode = s.market.state === "REFUND";
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending || s.wallet.status === "connecting";

  const seatName = (seat: number) => s.personas.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;

  // ── faction verdict (market 0) ──
  const factionMarket = (): BetMarket => {
    const winSide = s.market.winningSide;
    const outcome = s.market.outcome;
    const myYes = parseFloat(s.stakes.yes);
    const myNo = parseFloat(s.stakes.no);
    const myStake = myYes + myNo;
    const claimed = s.stakes.claimed;
    const isWin = settled && (outcome === "YES" || outcome === "NO");
    const isRefundOutcome = settled && (outcome === "DRAW" || outcome === "VOID");
    const myWinStake = winSide === "YES" ? myYes : winSide === "NO" ? myNo : 0;
    const won = isWin && myWinStake > 0 && !claimed;
    const canClaimRefund = isRefundOutcome && myStake > 0 && !claimed;
    const canRefundLiveness = refundMode && myStake > 0 && !claimed;

    const projected = (() => {
      if (!won || !winSide) return null;
      const total = parseFloat(s.market.yesPool) + parseFloat(s.market.noPool);
      const wp = winSide === "YES" ? parseFloat(s.market.yesPool) : parseFloat(s.market.noPool);
      return wp > 0 ? ((total * myWinStake) / wp).toFixed(4) : null;
    })();
    const refundAmount = (() => {
      if (outcome === "DRAW") return (myStake * (10000 - (s.feeBpsDraw ?? 0))) / 10000;
      if (outcome === "VOID" || refundMode) return myStake;
      return 0;
    })().toFixed(4);

    const status = open
      ? null
      : preOpen
        ? "Wagers open shortly"
        : s.market.state === "LOCKED"
          ? "🔒 Wagers sealed · match running"
          : claimed && myStake > 0
            ? isRefundOutcome || refundMode
              ? "Stake returned ✓"
              : "Payout claimed ✓"
            : isRefundOutcome
              ? outcome === "DRAW"
                ? "Mistrial · stakes returned"
                : "No verdict backed · stakes returned"
              : settled
                ? myStake > 0
                  ? "Your wager missed the verdict"
                  : "Settled · no wager placed"
                : refundMode
                  ? "Match abandoned · no wager placed"
                  : null;

    return {
      key: "faction",
      title: "Faction verdict",
      question: "Will the hidden hand walk free?",
      bettable: open,
      hasWager: myStake > 0,
      canClaim: won || canClaimRefund || canRefundLiveness,
      claimLabel: won ? `Claim ◈ ${projected ?? "…"}` : `Reclaim stake ◈ ${refundAmount}`,
      doClaim: () => void (canRefundLiveness ? refund() : claim()),
      place: (side) => void (open && !busy && placeBet(side, amount)),
      status,
      choices: [
        {
          side: "YES",
          eyebrow: "Mafia faction",
          eyebrowClass: "text-[#d98a55]",
          label: "ACQUITTED",
          sub: "the hidden hand walks free",
          accent: "text-[#d98a55]",
          bar: "bg-[#d98a55]",
          pool: s.market.yesPool,
          other: s.market.noPool,
          mine: myYes,
          winner: settled && winSide === "YES",
        },
        {
          side: "NO",
          eyebrow: "Town faction",
          eyebrowClass: "text-acquit",
          label: "CONVICTED",
          sub: "the Town roots them out",
          accent: "text-acquit",
          bar: "bg-acquit",
          pool: s.market.noPool,
          other: s.market.yesPool,
          mine: myNo,
          winner: settled && winSide === "NO",
        },
      ],
    };
  };

  // ── per-seat survival markets ──
  const aliveBySeat = new Map(s.seats.map((seat) => [seat.id, seat.alive]));
  const stakeByIdx = new Map(s.propStakes.map((ps) => [ps.index, ps]));
  const props = s.market.props ?? [];

  const seatMarket = (prop: (typeof props)[number]): BetMarket => {
    const name = seatName(prop.seat);
    const o: Outcome | undefined = prop.outcome;
    const survived = o === "YES";
    const fell = o === "NO";
    const isVoid = o === "VOID";
    const mine = stakeByIdx.get(prop.index);
    const myYes = mine ? parseFloat(mine.yes) : 0;
    const myNo = mine ? parseFloat(mine.no) : 0;
    const myStake = myYes + myNo;
    const claimed = mine?.claimed ?? false;
    const alive = aliveBySeat.get(prop.seat) ?? true;
    // A fallen/frozen seat's survival outcome is already decided — no more bets even while the match
    // (and faction market) stays open. The on-chain `closed` flag is authority; alive is the fallback.
    const decided = prop.closed === true || !alive;
    const bettable = open && !decided;
    const myWin = (survived && myYes > 0) || (fell && myNo > 0);
    const canClaim = !claimed && ((settled && (myWin || isVoid)) || (refundMode && myStake > 0));

    const status = bettable
      ? null
      : settled || refundMode
        ? claimed
          ? myWin || isVoid ? "Collected ✓" : "Settled · your wager missed"
          : survived
            ? "Survived to the end"
            : fell
              ? "Fell before the end"
              : isVoid
                ? "Void · stakes returned"
                : "Settled"
        : decided && open
          ? `${name} fell · market closed${myNo > 0 ? " · awaiting settlement" : ""}`
          : preOpen
            ? "Wagers open shortly"
            : "🔒 Market sealed";

    return {
      key: `seat-${prop.index}`,
      title: name,
      question: `Does ${name} survive to the end?`,
      bettable,
      hasWager: myStake > 0,
      canClaim,
      claimLabel: isVoid || refundMode ? "Reclaim stake" : "Claim winnings",
      doClaim: () => void (refundMode ? refundProp(prop.index) : claimProp(prop.index)),
      place: (side) => void (bettable && !busy && placePropBet(prop.index, side, amount)),
      status,
      choices: [
        {
          side: "YES",
          eyebrow: "to the final bell",
          eyebrowClass: "text-acquit",
          label: "SURVIVES",
          sub: "still standing when the court rises",
          accent: "text-acquit",
          bar: "bg-acquit",
          pool: prop.yesPool,
          other: prop.noPool,
          mine: myYes,
          winner: survived,
        },
        {
          side: "NO",
          eyebrow: "before the end",
          eyebrowClass: "text-convict",
          label: "FALLS",
          sub: "voted out or taken in the night",
          accent: "text-convict",
          bar: "bg-convict",
          pool: prop.noPool,
          other: prop.yesPool,
          mine: myNo,
          winner: fell,
        },
      ],
    };
  };

  const markets: BetMarket[] = [factionMarket(), ...props.map(seatMarket)];
  const total = markets.length;
  const safeIndex = Math.min(index, total - 1);
  const m = markets[safeIndex]!;

  // Reset the staged pick whenever the visible market changes (paging, or the index gets clamped).
  useEffect(() => setPicked(null), [safeIndex]);

  const go = (delta: number) => setIndex((i) => Math.max(0, Math.min(total - 1, Math.min(i, total - 1) + delta)));

  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  const maxStake = balance != null ? Math.max(0, balance) : null;
  const chips: { label: string; value: string }[] = [
    { label: "0.01", value: "0.01" },
    { label: "0.1", value: "0.1" },
    { label: "1", value: "1" },
    ...(maxStake != null && maxStake > 0 ? [{ label: "Max", value: maxStake.toFixed(3) }] : []),
  ];

  const isRefundOutcome = settled && (s.market.outcome === "DRAW" || s.market.outcome === "VOID");

  // The projected payout for the staged pick, shown right on the wager button.
  const stakeNum = parseFloat(amount);
  const pickedChoice = picked ? m.choices.find((c) => c.side === picked) : null;
  const projWin = pickedChoice ? projectWin(stakeNum, pickedChoice.pool, pickedChoice.other) : null;

  return (
    <aside className="panel flex min-h-0 flex-col overflow-hidden px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Wagers</div>
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
        <div className="mb-3 border-l-2 border-gilt/50 bg-gilt/[0.04] px-3 py-2.5 text-[13px] italic leading-snug text-cream-dim">
          {s.market.outcome === "DRAW"
            ? "The court reached no verdict — a mistrial. Every wager is returned, less a small fee."
            : s.market.outcome === "VOID"
              ? "A faction prevailed, but no wager backed it — so the market is void. Stakes returned in full."
              : "The match was abandoned before settlement. Reclaim your full stake on any market you backed."}
        </div>
      )}

      {/* ── Pager: one market at a time. Lit arrows + a dot per market make it obvious there is more
            than one bet on the table, and let you jump straight to any of them. ── */}
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous market"
          disabled={safeIndex === 0}
          onClick={() => go(-1)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-gilt/60 font-mono text-[20px] leading-none text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:border-line disabled:text-mute-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mute-2"
        >
          ‹
        </button>
        <div className="min-w-0 text-center">
          <div className="flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-cream">
            <span className="truncate">{m.title}</span>
            {m.hasWager && <span className="shrink-0 text-gilt" title="You hold a wager here">●</span>}
          </div>
          <div className="font-mono text-[10px] tracking-[0.1em] text-mute">
            Market {safeIndex + 1} of {total} · swipe through
          </div>
        </div>
        <button
          type="button"
          aria-label="Next market"
          disabled={safeIndex === total - 1}
          onClick={() => go(1)}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-gilt/60 font-mono text-[20px] leading-none text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:border-line disabled:text-mute-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-mute-2"
        >
          ›
        </button>
      </div>

      {/* Dot rail — one tap-target per market; current is a wider gilt pill, wagered ones carry a ring. */}
      {total > 1 && (
        <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5">
          {markets.map((mk, i) => (
            <button
              key={mk.key}
              type="button"
              aria-label={`Go to ${mk.title}`}
              aria-current={i === safeIndex}
              onClick={() => setIndex(i)}
              className={[
                "h-1.5 rounded-full transition-all",
                i === safeIndex ? "w-5 bg-gilt" : "w-1.5 hover:bg-cream-dim",
                i === safeIndex ? "" : mk.hasWager ? "bg-gilt/50" : "bg-line-2",
              ].join(" ")}
            />
          ))}
        </div>
      )}

      {/* Scrollable card area — only the question + its two choices live here. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mb-3 font-display text-[20px] leading-tight text-cream">{m.question}</div>
        <div className="flex flex-col gap-2.5">
          {m.choices.map((c) => (
            <ChoiceCard
              key={c.side}
              c={c}
              selected={picked === c.side}
              selectable={m.bettable && !busy}
              dimmed={open && !m.bettable && !c.winner}
              onSelect={() => setPicked(c.side)}
            />
          ))}
        </div>
      </div>

      {/* ── Persistent footer: stake + the one wager/claim action, fixed across all markets ── */}
      <div className="mt-4 border-t hairline pt-4">
        {m.bettable ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="eyebrow">Stake</span>
              {connected && balance != null ? (
                <span className="font-mono text-[11px] tracking-[0.06em] text-mute">bal {balance.toFixed(3)} CHIP</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px] text-mute">◈</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-20 border border-line bg-ink-2 px-2 py-1.5 font-mono text-[14px] text-cream outline-none focus:border-gilt"
              />
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-mute">CHIP</span>
              <div className="ml-auto flex gap-1.5">
                {chips.map((c) => (
                  <button
                    key={c.label}
                    type="button"
                    onClick={() => setAmount(c.value)}
                    className={[
                      "rounded-sm border px-2 py-1.5 font-mono text-[11.5px] tracking-[0.06em] transition-colors",
                      amount === c.value ? "border-gilt text-gilt" : "border-line text-mute hover:border-line-2 hover:text-cream-dim",
                    ].join(" ")}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            {!connected ? (
              <button
                type="button"
                onClick={() => void connect()}
                disabled={busy}
                className="mt-3 w-full rounded-sm border border-gilt px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
              >
                {s.wallet.status === "connecting" ? "Connecting…" : "Connect wallet to wager"}
              </button>
            ) : (
              <button
                type="button"
                disabled={!picked || busy || !(stakeNum > 0)}
                onClick={() => picked && m.place(picked)}
                className={[
                  "mt-3 w-full rounded-sm border px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] transition-colors",
                  picked && !busy && stakeNum > 0
                    ? "border-gilt text-gilt hover:bg-gilt hover:text-ink"
                    : "border-line text-mute cursor-default",
                ].join(" ")}
              >
                {busy
                  ? "Confirming on-chain…"
                  : !picked
                    ? "Pick a side above to wager"
                    : projWin != null
                      ? `Wager ◈${stakeNum.toFixed(3)} → win ◈${projWin.toFixed(3)}`
                      : "Enter a stake amount"}
              </button>
            )}
            {picked && !busy && (
              <div className="mt-1.5 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">
                on {m.choices.find((c) => c.side === picked)!.label}
                {m.hasWager ? " · adds to your wager" : ""}
              </div>
            )}
          </>
        ) : m.canClaim ? (
          <button
            type="button"
            onClick={m.doClaim}
            disabled={busy}
            className="w-full rounded-sm border border-acquit px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-acquit transition-colors hover:bg-acquit hover:text-ink disabled:opacity-60"
          >
            {busy ? "Confirming on-chain…" : m.claimLabel}
          </button>
        ) : (
          <div className="rounded-sm border border-line px-3 py-3 text-center font-mono text-[12px] uppercase tracking-[0.14em] text-mute">
            {m.status ?? "—"}
          </div>
        )}

        {s.tx.error && <div className="mt-2 text-center font-mono text-[11px] leading-snug text-convict">{s.tx.error}</div>}

        {/* Receipt: on-chain proof of the last wager/claim. */}
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

        {/* The settlement tx that verified the transcript and resolved the markets. */}
        {settled && s.settleTxHash && (
          <a
            href={explorerTx(s.settleTxHash)}
            target="_blank"
            rel="noreferrer"
            className="mt-2 flex items-center justify-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-mute transition-colors hover:text-cream"
          >
            ⚖ Verdict settled on-chain · {s.settleTxHash.slice(0, 6)}…{s.settleTxHash.slice(-4)}
            <span aria-hidden>↗</span>
          </a>
        )}

        <div className="mt-2.5 text-center font-mono text-[11px] tracking-[0.06em] text-mute">
          {connected
            ? `${s.wallet.account?.slice(0, 6)}…${s.wallet.account?.slice(-4)}${balance != null ? ` · ${balance.toFixed(3)} 0G` : ""} · 0G Galileo`
            : "connect a wallet to enter the record"}
        </div>
      </div>
    </aside>
  );
}
