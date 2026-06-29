import { useEffect, useState } from "react";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import type { PropSnapshot, Side } from "../../lib/types.js";
import { explorerTx } from "../../lib/contract.js";
import { useCountdown } from "../../lib/useCountdown.js";

function pct(pool: string, total: string): number {
  const a = parseFloat(pool);
  const t = parseFloat(total);
  return t > 0 ? Math.round((a / t) * 100) : 0;
}

/** Parimutuel return multiple if this choice wins: (whole pot) / (this choice's pool). From real pools. */
function mult(pool: string, total: string): string {
  const a = parseFloat(pool);
  const t = parseFloat(total);
  return a > 0 ? `×${(t / a).toFixed(2)}` : "—";
}

/** Parimutuel payout for staking `a` on a choice: its share of the whole pot if it wins. */
function projectWin(a: number, pool: string, total: string): number | null {
  if (!(a > 0)) return null;
  const p = parseFloat(pool);
  const t = parseFloat(total);
  return (a / (p + a)) * (t + a);
}

/**
 * Payout on an ALREADY-PLACED stake if its outcome wins: its share of the whole pot. Unlike
 * `projectWin` (which models a *new* stake added on top), `mine` is already inside `pool`/`total`,
 * so this must NOT add it again. Used by the per-market / portfolio "to win" figures.
 */
function existingWin(mine: number, pool: string, total: string): number {
  if (!(mine > 0)) return 0;
  const p = parseFloat(pool);
  const t = parseFloat(total);
  return p > 0 ? (t * mine) / p : 0;
}

// Compact status-pill palettes (text + border), one per market state.
const PILL = {
  gilt: "text-gilt border-gilt/40",
  acquit: "text-acquit border-acquit/50",
  acquitDim: "text-acquit/70 border-acquit/30",
  giltDim: "text-gilt/70 border-gilt/30",
  mute: "text-mute border-line-2",
  dim: "text-cream-dim border-line-2",
} as const;

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

// ── one outcome of a market ─────────────────────────────────────────────────────
interface Choice {
  /** Stable, unique within the market. Faction: "YES"/"NO". Props: "o<outcome>". */
  key: string;
  /** Small label above the verdict word — the faction / bucket framing. */
  eyebrow: string;
  eyebrowClass: string;
  /** The big display word for this outcome. */
  label: string;
  /** Plain-language meaning, one line. */
  sub: string;
  accent: string;
  bar: string;
  /** This choice's pool. */
  pool: string;
  /** Sum of every choice's pool in the market (for pct / multiplier / projection). */
  total: string;
  /** The connected wallet's stake already on this choice. */
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
        <span className="font-mono text-[15px] tabular-nums text-cream">{mult(c.pool, c.total)}</span>
      </div>
      <div className={["mt-1.5 font-display text-[21px] tracking-[0.1em]", c.accent].join(" ")}>{c.label}</div>
      <div className="mt-0.5 text-[13px] italic text-mute">{c.sub}</div>
      <div className="mt-2.5 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.06em] text-mute">
        <span>{pct(c.pool, c.total)}% of the pot backs this</span>
        <span>◈ {parseFloat(c.pool).toFixed(2)}</span>
      </div>
      <div className="mt-1.5 h-0.5 bg-line">
        <div className={["h-full", c.bar].join(" ")} style={{ width: `${pct(c.pool, c.total)}%` }} />
      </div>
      {c.mine > 0 && (
        <div className="mt-2 font-mono text-[10.5px] tracking-[0.06em] text-gilt">● your wager · ◈ {c.mine.toFixed(3)}</div>
      )}
    </button>
  );
}

// ── normalized market view-model (faction verdict + one per side market) ───────
interface BetMarket {
  key: string;
  title: string;
  question: string;
  choices: Choice[];
  /** Open and accepting bets (the market hasn't been frozen / decided). */
  bettable: boolean;
  /** The wallet already holds a stake somewhere in this market. */
  hasWager: boolean;
  /** Total CHIP the wallet has staked across this market's outcomes. */
  myStake: number;
  /** Best-case return if the wallet's backed outcome(s) win, at current pools (the "to win" figure). */
  myProjWin: number;
  /** Compact at-a-glance status word for the collapsed row. */
  pill: { text: string; cls: string };
  /** A claim/refund is available right now. */
  canClaim: boolean;
  claimLabel: string;
  doClaim: () => void;
  /** Place a wager on the chosen outcome (by its Choice.key). */
  place: (key: string) => void;
  /** Shown in the expanded body when the market is neither bettable nor claimable. */
  status: string | null;
}

// PlayerFate death-round buckets (MafiaMarket.FATE_BUCKETS == 5), in outcome order.
const FATE_COPY: ReadonlyArray<Pick<Choice, "eyebrow" | "eyebrowClass" | "label" | "sub" | "accent" | "bar">> = [
  { eyebrow: "to the final bell", eyebrowClass: "text-acquit", label: "SURVIVES", sub: "still standing when the court rises", accent: "text-acquit", bar: "bg-acquit" },
  { eyebrow: "first to fall", eyebrowClass: "text-convict", label: "OUT · R1", sub: "taken in the night or the opening vote", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "second round", eyebrowClass: "text-convict", label: "OUT · R2", sub: "falls in the second round", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "third round", eyebrowClass: "text-convict", label: "OUT · R3", sub: "falls in the third round", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "the long game", eyebrowClass: "text-convict", label: "OUT · R4+", sub: "holds on, then falls late", accent: "text-convict", bar: "bg-convict" },
];

// ── a single market in the at-a-glance list: collapsed header + (when open) inline outcomes+action ──
function MarketRow({
  m,
  open,
  onToggle,
  picked,
  setPicked,
  busy,
  connected,
  connecting,
  connect,
  amount,
  setAmount,
  stepStake,
  chips,
  balance,
  gasless,
  getTestTokens,
  minting,
}: {
  m: BetMarket;
  open: boolean;
  onToggle: () => void;
  picked: string | null;
  setPicked: (k: string) => void;
  busy: boolean;
  connected: boolean;
  connecting: boolean;
  connect: () => void;
  amount: string;
  setAmount: (a: string) => void;
  stepStake: (dir: number) => void;
  chips: { label: string; value: string }[];
  balance: number | null;
  gasless: boolean;
  getTestTokens: () => void;
  minting: boolean;
}) {
  // Collapsed-row peek: the crowd favorite (largest pool) + pot, or the winning outcome once settled.
  const fav = m.choices.length ? m.choices.reduce((a, b) => (parseFloat(b.pool) > parseFloat(a.pool) ? b : a)) : null;
  const winner = m.choices.find((c) => c.winner) ?? null;
  const potTotal = m.choices.length ? m.choices[0]!.total : "0";

  // Projected payout for the staged pick (a NEW stake) — only meaningful while this row is open.
  const stakeNum = parseFloat(amount);
  const pickedChoice = open && picked ? (m.choices.find((c) => c.key === picked) ?? null) : null;
  const projWin = pickedChoice ? projectWin(stakeNum, pickedChoice.pool, pickedChoice.total) : null;
  // Guard the wager before it costs a tx: the stepper clamps to balance but the text input doesn't, so
  // a typed stake can outrun the wallet. Only judge once we actually know the balance (null = unread).
  const exceedsBalance = connected && balance != null && stakeNum > balance;
  const canWager = !!picked && !busy && stakeNum > 0 && !exceedsBalance;

  return (
    <div className={["border transition-colors", open ? "border-line-2 bg-ink-2/40" : "border-line hover:border-line-2"].join(" ")}>
      {/* ── Collapsed header — title, status, odds peek, your position. Tap to expand. ── */}
      <button type="button" onClick={onToggle} className="flex w-full items-start justify-between gap-2 px-3.5 py-2.5 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream">
            <span className="truncate">{m.title}</span>
            {m.hasWager && <span className="shrink-0 text-gilt" title="You hold a wager here">●</span>}
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] tracking-[0.06em] text-mute">
            {winner ? (
              <span className="text-cream-dim">● {winner.label}</span>
            ) : fav ? (
              <>
                pot ◈{parseFloat(potTotal).toFixed(2)} · fav <span className="text-cream-dim">{fav.label}</span> {mult(fav.pool, fav.total)}
              </>
            ) : (
              "—"
            )}
            {m.myStake > 0 && <span className="text-gilt"> · ◈{m.myStake.toFixed(2)} in</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <span className={["rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]", m.pill.cls].join(" ")}>{m.pill.text}</span>
          <span className="w-3 text-center font-mono text-[12px] leading-none text-mute">{open ? "▾" : "▸"}</span>
        </div>
      </button>

      {/* ── Expanded body — the question, its outcomes, and the stake+confirm RIGHT HERE. ── */}
      {open && (
        <div className="border-t hairline px-3.5 pb-3.5 pt-3">
          <div className="mb-3 font-display text-[18px] leading-tight text-cream">{m.question}</div>
          <div className="flex flex-col gap-2.5">
            {m.choices.map((c) => (
              <ChoiceCard
                key={c.key}
                c={c}
                selected={picked === c.key}
                selectable={m.bettable && !busy}
                dimmed={!m.bettable && !c.winner}
                onSelect={() => setPicked(c.key)}
              />
            ))}
          </div>

          {/* Inline action zone — stake + the one wager/claim action, next to the cards. */}
          <div className="mt-3.5 border-t hairline pt-3.5">
            {m.bettable ? (
              <>
                <div className="mb-2 flex items-center justify-between">
                  <span className="eyebrow">Stake</span>
                  <div className="flex items-center gap-2">
                    {gasless && (
                      <span className="rounded-sm border border-gilt/50 px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-gilt">
                        ⛽ gasless
                      </span>
                    )}
                    {connected && balance != null && (
                      <span className="font-mono text-[11px] tracking-[0.06em] text-mute">bal {balance.toFixed(3)} CHIP</span>
                    )}
                    {connected && (
                      <button
                        type="button"
                        onClick={getTestTokens}
                        disabled={busy}
                        className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-mute transition-colors hover:border-gilt hover:text-gilt disabled:opacity-50"
                      >
                        {minting ? "minting…" : "+ CHIP"}
                      </button>
                    )}
                  </div>
                </div>

                {/* Stepper: big −/+ tap targets flanking the amount. */}
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label="Decrease stake"
                    onClick={() => stepStake(-1)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-line font-mono text-[20px] leading-none text-mute transition-colors hover:border-line-2 hover:text-cream"
                  >
                    −
                  </button>
                  <div className="flex flex-1 items-center gap-1.5 border border-line bg-ink-2 px-2.5 py-1.5 focus-within:border-gilt">
                    <span className="font-mono text-[12px] text-mute">◈</span>
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full bg-transparent font-mono text-[15px] tabular-nums text-cream outline-none"
                    />
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">CHIP</span>
                  </div>
                  <button
                    type="button"
                    aria-label="Increase stake"
                    onClick={() => stepStake(1)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-line font-mono text-[20px] leading-none text-mute transition-colors hover:border-line-2 hover:text-cream"
                  >
                    +
                  </button>
                </div>

                {/* Quick chips — full-width tap targets. */}
                <div className="mt-2 flex gap-1.5">
                  {chips.map((c) => (
                    <button
                      key={c.label}
                      type="button"
                      onClick={() => setAmount(c.value)}
                      className={[
                        "flex-1 rounded-sm border px-2 py-1.5 font-mono text-[11.5px] tracking-[0.06em] transition-colors",
                        amount === c.value ? "border-gilt text-gilt" : "border-line text-mute hover:border-line-2 hover:text-cream-dim",
                      ].join(" ")}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>

                {!connected ? (
                  <button
                    type="button"
                    onClick={() => void connect()}
                    disabled={busy}
                    className="mt-3 w-full rounded-sm border border-gilt px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
                  >
                    {connecting ? "Connecting…" : "Connect wallet to wager"}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={!canWager}
                      onClick={() => picked && m.place(picked)}
                      className={[
                        "mt-3 w-full rounded-sm border px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] transition-colors",
                        canWager
                          ? "border-gilt text-gilt hover:bg-gilt hover:text-ink"
                          : "border-line text-mute cursor-default",
                      ].join(" ")}
                    >
                      {busy
                        ? "Confirming on-chain…"
                        : !picked
                          ? "Pick an outcome above to wager"
                          : !(stakeNum > 0)
                            ? "Enter a stake amount"
                            : exceedsBalance
                              ? "Stake exceeds balance"
                              : projWin != null
                                ? `Wager ◈${stakeNum.toFixed(3)} → win ◈${projWin.toFixed(3)}`
                                : "Enter a stake amount"}
                    </button>
                    {/* The faucet lives only on the Menu, but you bet here — so when the stake outruns the
                        wallet, surface the remedy inline instead of a dead-end "exceeds balance" error. */}
                    {(exceedsBalance || minting) && (
                      <button
                        type="button"
                        onClick={getTestTokens}
                        disabled={busy}
                        className="mt-2 w-full rounded-sm border border-gilt/50 bg-gilt/[0.04] px-3 py-2.5 font-mono text-[11.5px] uppercase tracking-[0.14em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
                      >
                        {minting ? "Minting CHIP…" : "Get test CHIP — free mock money"}
                      </button>
                    )}
                  </>
                )}
                {picked && !busy && pickedChoice && (
                  <div className="mt-1.5 text-center font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">
                    on {pickedChoice.label}
                    {m.hasWager ? " · adds to your wager" : ""}
                  </div>
                )}
                {connected && gasless && (
                  <div className="mt-1.5 text-center font-mono text-[10px] tracking-[0.1em] text-gilt/70">
                    Gas sponsored — just sign, no 0G needed.
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
          </div>
        </div>
      )}
    </div>
  );
}

export function Verdict({ api }: { api: MatchApi }) {
  const { state: s, connect, placeBet, placePropBet, claim, claimProp, refund, refundProp } = api;
  const [amount, setAmount] = useState("0.01");
  // Faucet mint kicked off from the Wagers panel (the Menu's "Get test CHIP" isn't reachable mid-match).
  // Local flag only drives the button copy; `api.getTestTokens` owns the actual tx/pending state.
  const [minting, setMinting] = useState(false);
  const mint = () => {
    setMinting(true);
    void api.getTestTokens().finally(() => setMinting(false));
  };
  // Which market is expanded. null = use the sensible default; "__none__" = explicitly all-collapsed.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

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
    const canClaim = won || canClaimRefund || canRefundLiveness;
    const total = (parseFloat(s.market.yesPool) + parseFloat(s.market.noPool)).toString();

    const projected = (() => {
      if (!won || !winSide) return null;
      const t = parseFloat(s.market.yesPool) + parseFloat(s.market.noPool);
      const wp = winSide === "YES" ? parseFloat(s.market.yesPool) : parseFloat(s.market.noPool);
      return wp > 0 ? ((t * myWinStake) / wp).toFixed(4) : null;
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

    const myProjWin = existingWin(myYes, s.market.yesPool, total) + existingWin(myNo, s.market.noPool, total);
    const pill = open
      ? { text: "open", cls: PILL.gilt }
      : preOpen
        ? { text: "soon", cls: PILL.dim }
        : s.market.state === "LOCKED"
          ? { text: "sealed", cls: PILL.mute }
          : canClaim
            ? { text: "claim", cls: PILL.acquit }
            : (isRefundOutcome || refundMode) && myStake > 0
              ? { text: "returned", cls: PILL.giltDim }
              : isWin && myWinStake > 0
                ? { text: "collected", cls: PILL.acquitDim }
                : settled && myStake > 0
                  ? { text: "missed", cls: PILL.mute }
                  : { text: "settled", cls: PILL.mute };

    return {
      key: "faction",
      title: "Faction verdict",
      question: "Will the hidden hand walk free?",
      bettable: open,
      hasWager: myStake > 0,
      myStake,
      myProjWin,
      pill,
      canClaim,
      claimLabel: won ? `Claim ◈ ${projected ?? "…"}` : `Reclaim stake ◈ ${refundAmount}`,
      doClaim: () => void (canRefundLiveness ? refund() : claim()),
      place: (key) => void (open && !busy && placeBet(key as Side, amount)),
      status,
      choices: [
        {
          key: "YES",
          eyebrow: "Mafia faction",
          eyebrowClass: "text-[#d98a55]",
          label: "ACQUITTED",
          sub: "the hidden hand walks free",
          accent: "text-[#d98a55]",
          bar: "bg-[#d98a55]",
          pool: s.market.yesPool,
          total,
          mine: myYes,
          winner: settled && winSide === "YES",
        },
        {
          key: "NO",
          eyebrow: "Town faction",
          eyebrowClass: "text-acquit",
          label: "CONVICTED",
          sub: "the Town roots them out",
          accent: "text-acquit",
          bar: "bg-acquit",
          pool: s.market.noPool,
          total,
          mine: myNo,
          winner: settled && winSide === "NO",
        },
      ],
    };
  };

  // ── categorical side markets (PlayerFate per seat + the active per-round RoundVotedOut market) ──
  const aliveBySeat = new Map(s.seats.map((seat) => [seat.id, seat.alive]));
  const stakeByIdx = new Map(s.propStakes.map((ps) => [ps.index, ps]));
  const props = s.market.props ?? [];

  // "Voted out" is a RECURRING market — one per round. Show only the ACTIVE one live: the highest round
  // still open for bets (`closed` is on-chain truth, so this follows what's actually wagerable, not the
  // lagging playback round). Resolved past-round markets drop off the list and stay claimable in
  // History. PlayerFate markets always show. Once every round market is closed/settled, none show.
  const activeVoRound = Math.max(0, ...props.filter((p) => p.kind === "ROUND_VOTED_OUT" && !p.closed).map((p) => p.param));
  const liveProps = props.filter((p) => p.kind !== "ROUND_VOTED_OUT" || p.param === activeVoRound);

  const propMarket = (prop: PropSnapshot): BetMarket => {
    const total = prop.pools.reduce((acc, p) => acc + parseFloat(p), 0).toString();
    const mine = stakeByIdx.get(prop.index);
    const myStakeFor = (o: number) => (mine ? parseFloat(mine.stakes[o] ?? "0") : 0);
    const myTotalStake = mine ? mine.stakes.reduce((acc, v) => acc + parseFloat(v), 0) : 0;
    const claimed = mine?.claimed ?? false;
    const win = prop.state === "RESOLVED" ? prop.winningOutcome : undefined;
    const isVoid = prop.state === "VOID";
    // A decided market takes no more bets even while the match (and faction market) stays open. The
    // on-chain `closed` flag is authority; for PlayerFate a dead seat is the fallback (its fate is then
    // public). A single RoundVotedOut market resolves only when the host closes it (the vote is in).
    const decided = prop.closed === true || (prop.kind === "PLAYER_FATE" && !(aliveBySeat.get(prop.param) ?? true));
    const bettable = open && !decided;
    const myWin = win != null && myStakeFor(win) > 0;
    const canClaim = !claimed && ((settled && (myWin || isVoid)) || (refundMode && myTotalStake > 0));

    let title: string;
    let question: string;
    let choices: Choice[];
    if (prop.kind === "PLAYER_FATE") {
      const name = seatName(prop.param);
      title = `${name} · fate`;
      question = `What becomes of ${name}?`;
      choices = FATE_COPY.map((copy, o) => ({
        key: `o${o}`,
        ...copy,
        pool: prop.pools[o] ?? "0",
        total,
        mine: myStakeFor(o),
        winner: win === o,
      }));
    } else {
      const r = prop.param; // the day-vote round this market predicts (recurring)
      const noOne = prop.numOutcomes - 1; // the last outcome — a hung vote
      title = `Round ${r} vote`;
      question = `Who hangs in the round ${r} vote?`;
      choices = [];
      for (let seat = 0; seat < noOne; seat++) {
        const aliveNow = aliveBySeat.get(seat) ?? true;
        const seatPool = parseFloat(prop.pools[seat] ?? "0");
        // Live: only living seats are realistic targets. Settled/past: also surface the winner and any
        // seat that drew a wager, so the resolved card and reclaimable pots are always visible.
        if (!aliveNow && win !== seat && seatPool === 0 && myStakeFor(seat) === 0) continue;
        choices.push({
          key: `o${seat}`,
          eyebrow: `seat ${seat + 1}`,
          eyebrowClass: "text-convict",
          label: seatName(seat),
          sub: "to the gallows this round",
          accent: "text-convict",
          bar: "bg-convict",
          pool: prop.pools[seat] ?? "0",
          total,
          mine: myStakeFor(seat),
          winner: win === seat,
        });
      }
      choices.push({
        key: `o${noOne}`,
        eyebrow: "a hung vote",
        eyebrowClass: "text-acquit",
        label: "NO ONE",
        sub: "the vote ties — nobody hangs",
        accent: "text-acquit",
        bar: "bg-acquit",
        pool: prop.pools[noOne] ?? "0",
        total,
        mine: myStakeFor(noOne),
        winner: win === noOne,
      });
    }

    const awaiting = myTotalStake > 0 ? " · awaiting settlement" : "";
    const closedText =
      prop.kind === "ROUND_VOTED_OUT"
        ? `the round ${prop.param} vote is in · market closed${awaiting}`
        : `${seatName(prop.param)} fell · market closed${awaiting}`;
    const wonStatus = isVoid
      ? "Void · stakes returned"
      : win == null
        ? "Settled"
        : prop.kind === "ROUND_VOTED_OUT"
          ? win === prop.numOutcomes - 1
            ? "Hung vote · no one fell"
            : `${seatName(win)} was voted out`
          : `Fate · ${FATE_COPY[win]?.label ?? "settled"}`;
    const status = bettable
      ? null
      : settled || refundMode
        ? claimed
          ? myWin || isVoid
            ? "Collected ✓"
            : "Settled · your wager missed"
          : wonStatus
        : decided && open
          ? closedText
          : preOpen
            ? "Wagers open shortly"
            : "🔒 Market sealed";

    const myProjWin = choices.reduce((acc, c) => acc + existingWin(c.mine, c.pool, c.total), 0);
    const pill = bettable
      ? { text: "open", cls: PILL.gilt }
      : canClaim
        ? { text: "claim", cls: PILL.acquit }
        : preOpen
          ? { text: "soon", cls: PILL.dim }
          : (isVoid || refundMode) && myTotalStake > 0
            ? { text: "returned", cls: PILL.giltDim }
            : myWin
              ? { text: "collected", cls: PILL.acquitDim }
              : (settled || refundMode) && myTotalStake > 0
                ? { text: "missed", cls: PILL.mute }
                : settled
                  ? { text: "settled", cls: PILL.mute }
                  : { text: "sealed", cls: PILL.mute };

    return {
      key: `prop-${prop.index}`,
      title,
      question,
      bettable,
      hasWager: myTotalStake > 0,
      myStake: myTotalStake,
      myProjWin,
      pill,
      canClaim,
      claimLabel: isVoid || refundMode ? "Reclaim stake" : "Claim winnings",
      doClaim: () => void (refundMode ? refundProp(prop.index) : claimProp(prop.index)),
      place: (key) => void (bettable && !busy && placePropBet(prop.index, Number(key.slice(1)), amount)),
      status,
      choices,
    };
  };

  const markets: BetMarket[] = [factionMarket(), ...liveProps.map(propMarket)];

  // Which market is expanded. Default to the one that wants attention (a claim), else the first that
  // takes bets, else the first market. Follows the data if the open market drops off the list; the
  // "__none__" sentinel lets the user collapse everything.
  const defaultKey = (markets.find((mk) => mk.canClaim) ?? markets.find((mk) => mk.bettable) ?? markets[0])?.key ?? null;
  const effectiveOpen =
    openKey === "__none__" ? null : openKey && markets.some((mk) => mk.key === openKey) ? openKey : defaultKey;
  const toggle = (key: string) => setOpenKey(key === effectiveOpen ? "__none__" : key);

  // Clear the staged pick whenever the open market changes.
  useEffect(() => setPicked(null), [effectiveOpen]);

  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  const maxStake = balance != null ? Math.max(0, balance) : null;
  const chips: { label: string; value: string }[] = [
    { label: "0.01", value: "0.01" },
    { label: "0.1", value: "0.1" },
    { label: "1", value: "1" },
    ...(maxStake != null && maxStake > 0 ? [{ label: "Max", value: maxStake.toFixed(3) }] : []),
  ];

  // Stepper: nudge the stake by a magnitude-scaled increment, clamped to [0, balance].
  const stepStake = (dir: number) => {
    const v = parseFloat(amount) || 0;
    const inc = v < 0.1 ? 0.01 : v < 1 ? 0.1 : 1;
    let next = v + dir * inc;
    if (next < 0) next = 0;
    if (maxStake != null && next > maxStake) next = maxStake;
    setAmount(String(Number(next.toFixed(3))));
  };

  const isRefundOutcome = settled && (s.market.outcome === "DRAW" || s.market.outcome === "VOID");

  // Portfolio roll-up across every market the wallet holds a position in.
  const myPositions = markets.filter((mk) => mk.myStake > 0);
  const portfolioStaked = myPositions.reduce((acc, mk) => acc + mk.myStake, 0);
  const portfolioWin = myPositions.reduce((acc, mk) => acc + mk.myProjWin, 0);

  return (
    <aside className="panel flex h-full min-h-0 flex-col overflow-hidden px-5 py-5">
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

      {/* ── Portfolio strip: where your money is, at a glance, across every market. ── */}
      {connected && myPositions.length > 0 && (
        <div className="mb-3 border border-gilt/30 bg-gilt/[0.04] px-3 py-2.5">
          <div className="flex items-baseline justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-gilt">Your book</span>
            <span className="font-mono text-[10px] tracking-[0.06em] text-mute">
              in {myPositions.length} {myPositions.length === 1 ? "market" : "markets"}
            </span>
          </div>
          <div className="mt-1.5 flex items-baseline justify-between font-mono tabular-nums">
            <div>
              <span className="text-[10px] uppercase tracking-[0.1em] text-mute">staked </span>
              <span className="text-[15px] text-cream">◈{portfolioStaked.toFixed(2)}</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] uppercase tracking-[0.1em] text-mute">to win </span>
              <span className="text-[15px] text-acquit">◈{portfolioWin.toFixed(2)}</span>
            </div>
          </div>
          <div className="mt-0.5 text-right font-mono text-[9.5px] italic tracking-[0.04em] text-mute">if your picks land</div>
        </div>
      )}

      {/* ── The market list — every bet on the table, scannable. Tap a row to expand one. ── */}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {markets.map((mk) => (
          <MarketRow
            key={mk.key}
            m={mk}
            open={mk.key === effectiveOpen}
            onToggle={() => toggle(mk.key)}
            picked={picked}
            setPicked={setPicked}
            busy={busy}
            connected={connected}
            connecting={s.wallet.status === "connecting"}
            connect={connect}
            amount={amount}
            setAmount={setAmount}
            stepStake={stepStake}
            chips={chips}
            balance={balance}
            gasless={api.gasless}
            getTestTokens={mint}
            minting={minting}
          />
        ))}
      </div>

      {/* ── Slim global footer: cross-market wallet identity + on-chain receipts. ── */}
      <div className="mt-4 border-t hairline pt-3">
        {s.tx.error && <div className="mb-2 text-center font-mono text-[11px] leading-snug text-convict">{s.tx.error}</div>}

        {/* Receipt: on-chain proof of the last wager/claim. */}
        {s.tx.lastHash && !s.tx.pending && (
          <a
            href={explorerTx(s.tx.lastHash)}
            target="_blank"
            rel="noreferrer"
            className="flex items-center justify-center gap-1.5 font-mono text-[11px] tracking-[0.08em] text-acquit transition-colors hover:text-cream"
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
