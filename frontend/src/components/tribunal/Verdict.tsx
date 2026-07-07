import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import type { PropSnapshot } from "../../lib/types.js";
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

/**
 * Track a number across renders and briefly report whether it just ROSE or FELL, so the UI can flash a
 * green/red cue when the odds move. Returns null except for `ms` after a change. Because a bet reprices
 * the whole market at once (the backed outcome's share up, the rest down), driving this off each outcome's
 * pot fraction makes the whole book visibly tick the instant money moves. No flash on the first render.
 */
function useValueFlash(value: number, ms = 800): "up" | "down" | null {
  const prev = useRef(value);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = value;
    if (value === p) return;
    setDir(value > p ? "up" : "down");
    const t = setTimeout(() => setDir(null), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return dir;
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
  // The headline verdict rides in the FACTION prop now: VOID = a mistrial / unbacked verdict (full refund).
  const factionVoid = (s.market.props ?? []).find((p) => p.kind === "FACTION")?.state === "VOID";
  const settledText = factionVoid ? "No verdict backed · stakes returned" : "Verdict settled on-chain";
  const map: Record<string, { text: string; cls: string }> = {
    OPEN: preOpen
      ? { text: "Opening shortly", cls: "text-cream-dim" }
      : { text: "Open", cls: "text-gilt" },
    LOCKED: { text: "Closed", cls: "text-cream-dim" },
    SETTLED: { text: settledText, cls: "text-acquit border-acquit/40" },
    REFUND: { text: "Match abandoned", cls: "text-gilt border-gilt/40" },
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
  /** Stable, unique within the market — "o<outcome>" for every market (the faction market included). */
  key: string;
  /** Small label above the verdict word — the faction / bucket framing. */
  eyebrow: string;
  eyebrowClass: string;
  /** The big display word for this outcome. */
  label: string;
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
  bettable,
  dimmed,
  onSelect,
}: {
  c: Choice;
  selected: boolean;
  selectable: boolean;
  /** The market still takes bets — drives whether the per-choice figure reads as a projection vs a result. */
  bettable: boolean;
  dimmed: boolean;
  onSelect: () => void;
}) {
  // Odds/pool only read as data once the market actually holds wagers; before then a card would show a
  // wall of "0% · ◈0.00 · —" noise, so an empty pool collapses to a single quiet line instead.
  const hasPool = parseFloat(c.total) > 0;
  const m = mult(c.pool, c.total);
  // Precise pot fraction (not the rounded %) drives the bar width + the move-flash, so even a sub-1% shift
  // registers — the rounded "%" text can sit still while the bar eases and the up/down cue fires.
  const frac = parseFloat(c.total) > 0 ? (parseFloat(c.pool) / parseFloat(c.total)) * 100 : 0;
  const dir = useValueFlash(Math.round(frac * 10) / 10);
  const flashText = dir === "up" ? "text-acquit" : dir === "down" ? "text-convict" : "text-mute";
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={[
        "relative w-full border px-3.5 py-2.5 text-left transition-colors",
        selected
          ? "border-gilt bg-gilt/[0.06]"
          : c.mine > 0
            ? "border-gilt/60 bg-gilt/[0.03]"
            : c.winner
              ? c.accent.replace("text-", "border-")
              : "border-line-2",
        selectable ? "cursor-pointer hover:border-gilt/60" : "cursor-default",
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
      <div className="flex items-center justify-between gap-1.5">
        <span className={["truncate font-mono text-[10px] uppercase tracking-[0.14em]", c.eyebrowClass].join(" ")}>{c.eyebrow}</span>
        <span className={["shrink-0 font-mono text-[15px] tabular-nums", hasPool && m !== "—" ? "text-cream" : "text-mute-2"].join(" ")}>{m}</span>
      </div>
      <div className={["mt-1 font-display text-[21px] tracking-[0.1em]", c.accent].join(" ")}>{c.label}</div>
      {hasPool ? (
        <>
          <div className="mt-2 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.06em] text-mute">
            <span className={["inline-flex items-center gap-1 transition-colors duration-700", flashText].join(" ")}>
              {pct(c.pool, c.total)}% of pot
              <span aria-hidden className={["text-[8px] leading-none transition-opacity duration-300", dir ? "opacity-100" : "opacity-0"].join(" ")}>
                {dir === "down" ? "▼" : "▲"}
              </span>
            </span>
            <span>◈ {parseFloat(c.pool).toFixed(2)}</span>
          </div>
          <div className="mt-1.5 h-0.5 bg-line">
            <div className={["h-full transition-[width] duration-500 ease-out", c.bar].join(" ")} style={{ width: `${Math.min(100, frac).toFixed(2)}%` }} />
          </div>
        </>
      ) : (
        <div className="mt-1.5 font-mono text-[10px] tracking-[0.08em] text-mute-2">no wagers yet</div>
      )}
      {/* Your position on THIS outcome — the amount always, plus the payout it stands to return (a live
          projection while betting is open; the realized payout once it's the winning outcome). A losing /
          voided outcome shows only the stake, so no wrong "to win" is implied after settlement. */}
      {c.mine > 0 && (
        <div className="mt-2 flex items-center justify-between gap-1 rounded-sm border border-gilt/40 bg-gilt/[0.09] px-2 py-1 font-mono text-[10.5px] tracking-[0.03em]">
          <span className="text-gilt">● ◈{c.mine.toFixed(2)} yours</span>
          {c.winner ? (
            <span className="text-acquit">pays ◈{existingWin(c.mine, c.pool, c.total).toFixed(2)}</span>
          ) : bettable ? (
            <span className="text-cream-dim">→ ◈{existingWin(c.mine, c.pool, c.total).toFixed(2)}</span>
          ) : null}
        </div>
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
const FATE_COPY: ReadonlyArray<Pick<Choice, "eyebrow" | "eyebrowClass" | "label" | "accent" | "bar">> = [
  { eyebrow: "to the final bell", eyebrowClass: "text-acquit", label: "SURVIVES", accent: "text-acquit", bar: "bg-acquit" },
  { eyebrow: "first to fall", eyebrowClass: "text-convict", label: "OUT · R1", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "second round", eyebrowClass: "text-convict", label: "OUT · R2", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "third round", eyebrowClass: "text-convict", label: "OUT · R3", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "the long game", eyebrowClass: "text-convict", label: "OUT · R4+", accent: "text-convict", bar: "bg-convict" },
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
  connectBurner,
  amount,
  setAmount,
  stepStake,
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
  connectBurner: () => void;
  amount: string;
  setAmount: (a: string) => void;
  stepStake: (dir: number) => void;
  balance: number | null;
  gasless: boolean;
  getTestTokens: () => void;
  minting: boolean;
}) {
  // Collapsed-row peek: the crowd favorite (largest pool) + pot, or the winning outcome once settled.
  const fav = m.choices.length ? m.choices.reduce((a, b) => (parseFloat(b.pool) > parseFloat(a.pool) ? b : a)) : null;
  const winner = m.choices.find((c) => c.winner) ?? null;
  const potTotal = m.choices.length ? m.choices[0]!.total : "0";
  // Flash the pot when money moves so a COLLAPSED row still reads as live (during betting the pot only
  // grows, so this pulses green on any wager in the market — the at-a-glance "something's happening" cue).
  const potDir = useValueFlash(Math.round(parseFloat(potTotal) * 100) / 100);
  // Name the outcome(s) the wallet is on right in the collapsed row — a lone pick reads "on CONVICTED",
  // a hedge reads "across N picks" — so the position is legible without expanding the market.
  const myPicks = m.choices.filter((c) => c.mine > 0);
  const myPositionLabel = myPicks.length === 1 ? `on ${myPicks[0]!.label}` : `across ${myPicks.length} picks`;

  // Projected payout for the staged pick (a NEW stake) — only meaningful while this row is open.
  const stakeNum = parseFloat(amount);
  const pickedChoice = open && picked ? (m.choices.find((c) => c.key === picked) ?? null) : null;
  const projWin = pickedChoice ? projectWin(stakeNum, pickedChoice.pool, pickedChoice.total) : null;
  // Guard the wager before it costs a tx: the stepper clamps to balance but the text input doesn't, so
  // a typed stake can outrun the wallet. Only judge once we actually know the balance (null = unread).
  const exceedsBalance = connected && balance != null && stakeNum > balance;
  const canWager = !!picked && !busy && stakeNum > 0 && !exceedsBalance;

  // A sealed / settled / missed market carries no live action — recede it in the list (dull frame +
  // dimmed title) so the eye lands on the markets that are actually open or claimable.
  const dull = !m.bettable && !m.canClaim;

  return (
    <div
      className={[
        "border transition-colors",
        open
          ? dull
            ? "border-line-2 bg-ink-2/20"
            : "border-gilt/50 bg-ink-2/40"
          : m.canClaim
            ? "border-acquit/40 hover:border-acquit/60"
            : dull
              ? "border-line/50 hover:border-line-2"
              : "border-gilt/40 hover:border-gilt/60",
      ].join(" ")}
    >
      {/* ── Collapsed header — title, status, odds peek, your position. Tap to expand. A sealed / settled
          row carries no live action, so the whole collapsed row recedes (dimmed) and lifts back on hover
          so it still reads as tappable. Only when collapsed — an expanded sealed market stays readable. ── */}
      <button
        type="button"
        onClick={onToggle}
        className={[
          "flex w-full items-start justify-between gap-2 px-3.5 py-2.5 text-left transition-opacity",
          dull && !open ? "opacity-55 hover:opacity-90" : "",
        ].join(" ")}
      >
        <div className="min-w-0 flex-1">
          <div className={["flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em]", dull ? "text-cream-dim" : "text-cream"].join(" ")}>
            <span className="truncate">{m.title}</span>
            {m.hasWager && <span className="shrink-0 text-gilt" title="You hold a wager here">●</span>}
          </div>
          <div className="mt-1 truncate font-mono text-[10.5px] tracking-[0.06em] text-mute">
            {winner ? (
              <span className="text-cream-dim">● {winner.label}</span>
            ) : fav ? (
              <>
                pot <span className={["transition-colors duration-700", potDir === "up" ? "text-acquit" : potDir === "down" ? "text-convict" : ""].join(" ")}>◈{parseFloat(potTotal).toFixed(2)}</span> · fav <span className="text-cream-dim">{fav.label}</span> {mult(fav.pool, fav.total)}
              </>
            ) : (
              "—"
            )}
            {m.myStake > 0 && <span className="text-gilt"> · ◈{m.myStake.toFixed(2)} {myPositionLabel}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <span className={["rounded-sm border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]", m.pill.cls].join(" ")}>{m.pill.text}</span>
          <motion.span
            aria-hidden
            animate={{ rotate: open ? 90 : 0 }}
            transition={{ duration: 0.24, ease: "easeInOut" }}
            className="inline-block w-3 text-center font-mono text-[12px] leading-none text-mute"
          >
            ▸
          </motion.span>
        </div>
      </button>

      {/* ── Expanded body — the question, its outcomes, and the stake+confirm RIGHT HERE. ── */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="border-t hairline px-3.5 pb-3.5 pt-3">
          <div className="mb-3 font-display text-[18px] leading-tight text-cream">{m.question}</div>
          {/* Tile the outcomes to the panel width — as many per row as fit (≈165px each), instead of
              one tall card per row with a wasteland of empty space beside it. */}
          <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(165px,1fr))]">
            {m.choices.map((c) => (
              <ChoiceCard
                key={c.key}
                c={c}
                selected={picked === c.key}
                selectable={m.bettable && !busy}
                bettable={m.bettable}
                dimmed={!m.bettable && !c.winner}
                onSelect={() => setPicked(c.key)}
              />
            ))}
          </div>

          {/* Inline action zone — stake + the one wager/claim action, next to the cards. */}
          <div className="mt-3.5 border-t hairline pt-3.5">
            {m.bettable ? (
              <>
                {/* <div className="mb-2 flex items-center justify-between">
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
                </div> */}

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

                {!connected ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void connect()}
                      disabled={busy}
                      className="mt-3 w-full rounded-sm border border-gilt px-3 py-3 font-mono text-[12.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
                    >
                      {connecting ? "Connecting…" : "Connect wallet to wager"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void connectBurner()}
                      disabled={busy}
                      className="mt-2 w-full font-mono text-[10.5px] uppercase tracking-[0.14em] text-mute transition-colors hover:text-gilt disabled:opacity-60"
                    >
                      or play as guest — no wallet, no pop-ups
                    </button>
                  </>
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function Verdict({ api }: { api: MatchApi }) {
  const { state: s, connect, connectBurner, placePropBet, claimProp, refundProp } = api;
  const [amount, setAmount] = useState("10.0");
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
  // The scrollable market list — snapped back to the top when a betting window hoists its market up there.
  const listRef = useRef<HTMLDivElement>(null);

  const live = s.market.state === "OPEN" && s.market.bettingLive === true;
  const preOpen = s.market.state === "OPEN" && !s.market.bettingLive;
  // Bets are only accepted on-chain while live — AND never once the verdict is on stage. The server
  // freezes every market before it broadcasts the reveal, so the closed snapshot normally shuts betting
  // first; this is the belt-and-suspenders that guarantees no market takes a wager the moment the
  // spectator is looking at the outcome (playbackComplete = the reveal is showing), even during the brief
  // gap before settle() lands the terminal snapshot.
  const open = live && !s.playbackComplete;
  const countdown = useCountdown(live ? s.market.closesAt : null);
  const closingSoon = countdown != null && countdown.ms <= 15000;
  // The synchronized in-loop betting window on stage (if any) — spotlights ONE market with its own countdown.
  const windowCountdown = useCountdown(s.betWindow?.endsAt ?? null);
  const windowClosing = windowCountdown != null && windowCountdown.ms <= 10000;
  // Pre-match betting hold: the fresh court has convened and betting is open before the first night. Only
  // before any beat lands (cursor < 0); the countdown makes the new round unmistakable and paces its wagers.
  const preMatchCountdown = useCountdown(s.market.preMatchEndsAt ?? null);
  const preMatchOpen = s.cursor < 0 && preMatchCountdown != null;
  const settled = s.market.state === "SETTLED";
  const refundMode = s.market.state === "REFUND";
  const connected = s.wallet.status === "connected";
  const busy = s.tx.pending || s.wallet.status === "connecting";

  const seatName = (seat: number) => s.personas.find((p) => p.seat === seat)?.name ?? `Seat ${seat + 1}`;

  // ── every market is a categorical prop: the headline FACTION market + PlayerFate per seat + the active
  //    per-round RoundVotedOut / NightKill markets + the DetectiveClaim / MafiaSeat markets ──
  const aliveBySeat = new Map(s.seats.map((seat) => [seat.id, seat.alive]));
  const stakeByIdx = new Map(s.propStakes.map((ps) => [ps.index, ps]));
  const props = s.market.props ?? [];
  // The headline faction market, VOID = a mistrial / unbacked verdict → full refund (drives the banner).
  const factionProp = props.find((p) => p.kind === "FACTION") ?? null;
  const factionVoid = settled && factionProp?.state === "VOID";

  // "Voted out" and "night kill" are each RECURRING markets — one per round, floated on-demand as the
  // match reaches each round (so `props` only ever holds rounds that have actually started, never empty
  // future ones). EVERY round's market stays in the list for the whole match: once its betting window
  // closes it collapses to a resolved / awaiting-settlement row (still claimable here and from History)
  // rather than vanishing the instant betting closed — which read as the wager itself disappearing. The
  // active round is surfaced regardless of list position (auto-expanded, spotlighted during its window).
  //
  // Gate the recurring markets by what the PLAYBACK has reached, not what's on-chain: their props open
  // ahead of the paced stream (round 1's at match creation, later rounds a beat early), so listing them
  // the instant they exist floats a "Night 2 kill" row before the stream has even reached night 2. Hide a
  // NIGHT_KILL / ROUND_VOTED_OUT / DETECTIVE_CLAIM market until its narrative beat is on stage (the reached*
  // marks are monotonic). The always-on headline markets (FACTION, MAFIA_SEAT) are never gated, and once
  // the match is done — or fully watched — every market shows so all winnings stay claimable from the list.
  const showAllMarkets = settled || refundMode || s.playbackComplete;
  const liveProps = props.filter((p) => {
    if (showAllMarkets) return true;
    if (p.kind === "NIGHT_KILL") return p.param <= s.reachedNight;
    if (p.kind === "ROUND_VOTED_OUT") return p.param <= s.reachedDay;
    if (p.kind === "DETECTIVE_CLAIM") return s.reachedClaim;
    return true;
  });

  const propMarket = (prop: PropSnapshot): BetMarket => {
    const mine = stakeByIdx.get(prop.index);
    const authMine = (o: number) => (mine ? parseFloat(mine.stakes[o] ?? "0") : 0);
    // Optimistic overlay: fold any just-placed local wager on THIS market into the pools + own-stake so the
    // odds move on the click, not after the chain round-trip. Each wager keeps contributing to a field only
    // until that field's authoritative source catches up — the server pool (basePool + amount) and the
    // own-stake read (baseMine + amount) reconcile INDEPENDENTLY, so the book never double-counts your bet.
    const opt = s.optimisticBets.filter((b) => b.propIdx === prop.index);
    const mineAdd = (o: number) =>
      opt.reduce((acc, b) => (b.outcome === o ? acc + Math.max(0, b.baseMine + b.amount - authMine(o)) : acc), 0);
    const augPools = prop.pools.map((p, o) => {
      const raw = parseFloat(p);
      const add = opt.reduce((acc, b) => (b.outcome === o ? acc + Math.max(0, b.basePool + b.amount - raw) : acc), 0);
      return String(raw + add);
    });
    const total = augPools.reduce((acc, p) => acc + parseFloat(p), 0).toString();
    const myStakeFor = (o: number) => authMine(o) + mineAdd(o);
    const myTotalStake = augPools.reduce((acc, _p, o) => acc + myStakeFor(o), 0);
    const claimed = mine?.claimed ?? false;
    const win = prop.state === "RESOLVED" ? prop.winningOutcome : undefined;
    const isVoid = prop.state === "VOID";
    // A decided market takes no more bets even while the match (and faction market) stays open. The
    // on-chain `closed` flag is authority; for PlayerFate a dead seat is the fallback (its fate is then
    // public). A RoundVotedOut / NightKill market resolves only when the host closes it (vote in / dawn broke).
    const decided = prop.closed === true || (prop.kind === "PLAYER_FATE" && !(aliveBySeat.get(prop.param) ?? true));
    const bettable = open && !decided;
    const myWin = win != null && myStakeFor(win) > 0;
    // A claim/refund only exists if you actually staked here: a win implies a stake on the winning
    // outcome; a void or liveness refund returns your stake — so all three require myTotalStake > 0.
    const canClaim = !claimed && ((settled && (myWin || (isVoid && myTotalStake > 0))) || (refundMode && myTotalStake > 0));

    let title: string;
    let question: string;
    let choices: Choice[];
    if (prop.kind === "FACTION") {
      // The headline market — binary: outcome 1 = MAFIA wins (ACQUITTED), 0 = TOWN wins (CONVICTED).
      title = "Faction verdict";
      question = "Will the hidden hand walk free?";
      choices = [
        {
          key: "o1", eyebrow: "Mafia faction", eyebrowClass: "text-[#d98a55]",
          label: "ACQUITTED", accent: "text-[#d98a55]", bar: "bg-[#d98a55]",
          pool: augPools[1] ?? "0", total, mine: myStakeFor(1), winner: win === 1,
        },
        {
          key: "o0", eyebrow: "Town faction", eyebrowClass: "text-acquit",
          label: "CONVICTED", accent: "text-acquit", bar: "bg-acquit",
          pool: augPools[0] ?? "0", total, mine: myStakeFor(0), winner: win === 0,
        },
      ];
    } else if (prop.kind === "PLAYER_FATE") {
      const name = seatName(prop.param);
      title = `${name} · fate`;
      question = `What becomes of ${name}?`;
      choices = FATE_COPY.map((copy, o) => ({
        key: `o${o}`,
        ...copy,
        pool: augPools[o] ?? "0",
        total,
        mine: myStakeFor(o),
        winner: win === o,
      }));
    } else if (prop.kind === "DETECTIVE_CLAIM") {
      // Binary reveal fork — outcome 1 = REAL DETECTIVE, 0 = BLUFF. Keyed to the claiming seat; it
      // resolves from the revealed roles at settle. REAL first (the claim as stated), then BLUFF.
      const name = seatName(prop.param);
      title = `${name} · claim`;
      question = `Is ${name}'s Detective claim real — or a bluff?`;
      choices = [
        {
          key: "o1", eyebrow: "the real detective", eyebrowClass: "text-acquit",
          label: "REAL", accent: "text-acquit", bar: "bg-acquit",
          pool: augPools[1] ?? "0", total, mine: myStakeFor(1), winner: win === 1,
        },
        {
          key: "o0", eyebrow: "a fake claim", eyebrowClass: "text-convict",
          label: "BLUFF", accent: "text-convict", bar: "bg-convict",
          pool: augPools[0] ?? "0", total, mine: myStakeFor(0), winner: win === 0,
        },
      ];
    } else if (prop.kind === "MAFIA_SEAT") {
      // "Who is the Mafia?" — one outcome per seat, resolved to the Mafia seat from the revealed roles at
      // settle. A dead seat can still be unmasked as the Mafia, so every seat stays shown the whole match.
      title = "Who is the Mafia?";
      question = "Which player is secretly the Mafia?";
      choices = [];
      for (let seat = 0; seat < prop.numOutcomes; seat++) {
        choices.push({
          key: `o${seat}`,
          eyebrow: `seat ${seat + 1}`,
          eyebrowClass: "text-convict",
          label: seatName(seat),
          accent: "text-convict",
          bar: "bg-convict",
          pool: augPools[seat] ?? "0",
          total,
          mine: myStakeFor(seat),
          winner: win === seat,
        });
      }
    } else {
      // ROUND_VOTED_OUT and NIGHT_KILL share the same shape — outcomes 0..n-1 are the seats, the last is
      // "no one" — differing only in framing (the day vote vs the night's kill before dawn).
      const isNight = prop.kind === "NIGHT_KILL";
      const r = prop.param; // the round this market predicts (recurring)
      const noOne = prop.numOutcomes - 1; // the last outcome — a hung vote / a quiet night
      title = isNight ? `Night ${r} kill` : `Round ${r} vote`;
      question = isNight ? `Who falls before dawn in night ${r}?` : `Who hangs in the round ${r} vote?`;
      choices = [];
      for (let seat = 0; seat < noOne; seat++) {
        const aliveNow = aliveBySeat.get(seat) ?? true;
        const seatPool = parseFloat(augPools[seat] ?? "0");
        // Live: only living seats are realistic targets. Settled/past: also surface the winner and any
        // seat that drew a wager, so the resolved card and reclaimable pots are always visible.
        if (!aliveNow && win !== seat && seatPool === 0 && myStakeFor(seat) === 0) continue;
        choices.push({
          key: `o${seat}`,
          eyebrow: `seat ${seat + 1}`,
          eyebrowClass: "text-convict",
          label: seatName(seat),
          accent: "text-convict",
          bar: "bg-convict",
          pool: augPools[seat] ?? "0",
          total,
          mine: myStakeFor(seat),
          winner: win === seat,
        });
      }
      choices.push({
        key: `o${noOne}`,
        eyebrow: isNight ? "a quiet night" : "a hung vote",
        eyebrowClass: "text-acquit",
        label: isNight ? "ALL SPARED" : "NO ONE",
        accent: "text-acquit",
        bar: "bg-acquit",
        pool: augPools[noOne] ?? "0",
        total,
        mine: myStakeFor(noOne),
        winner: win === noOne,
      });
    }

    const awaiting = myTotalStake > 0 ? " · awaiting settlement" : "";
    const closedText =
      prop.kind === "FACTION"
        ? `the verdict is in · market closed${awaiting}`
        : prop.kind === "ROUND_VOTED_OUT"
          ? `the round ${prop.param} vote is in · market closed${awaiting}`
          : prop.kind === "NIGHT_KILL"
            ? `dawn broke on night ${prop.param} · market closed${awaiting}`
            : prop.kind === "DETECTIVE_CLAIM"
              ? `${seatName(prop.param)}'s claim · market closed${awaiting}`
              : prop.kind === "MAFIA_SEAT"
                ? `the Mafia stands unmasked · market closed${awaiting}`
                : `${seatName(prop.param)} fell · market closed${awaiting}`;
    const wonStatus = isVoid
      ? "Void · stakes returned"
      : win == null
        ? "Settled"
        : prop.kind === "FACTION"
          ? win === 1
            ? "The hidden hand walked · Mafia acquitted"
            : "The Town prevailed · Mafia convicted"
          : prop.kind === "ROUND_VOTED_OUT"
            ? win === prop.numOutcomes - 1
              ? "Hung vote · no one fell"
              : `${seatName(win)} was voted out`
            : prop.kind === "NIGHT_KILL"
              ? win === prop.numOutcomes - 1
                ? "A quiet night · all spared"
                : `${seatName(win)} fell in the night`
              : prop.kind === "DETECTIVE_CLAIM"
                ? win === 1
                  ? `${seatName(prop.param)} was the real Detective`
                  : `${seatName(prop.param)} was bluffing`
                : prop.kind === "MAFIA_SEAT"
                  ? `${seatName(win)} was the Mafia`
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

  // Order the markets: the headline faction verdict first, then the marquee "Who is the Mafia?", then the
  // per-seat / per-round props (which otherwise precede them in prop-array order).
  const factionProps = liveProps.filter((p) => p.kind === "FACTION");
  const mafiaProps = liveProps.filter((p) => p.kind === "MAFIA_SEAT");
  const otherProps = liveProps.filter((p) => p.kind !== "MAFIA_SEAT" && p.kind !== "FACTION");
  const markets: BetMarket[] = [...factionProps, ...mafiaProps, ...otherProps].map(propMarket);

  // Which market is expanded. An active betting window FORCES its market open (that's the point of the
  // window — the spotlighted market is front-and-centre). Otherwise: the one that wants attention (a claim),
  // else the first that takes bets, else the first market. The "__none__" sentinel lets the user collapse.
  const windowKey = s.betWindow ? `prop-${s.betWindow.propIndex}` : null;
  // Hoist the spotlighted (countdown) market to the TOP of the list — otherwise a mid-match window (e.g.
  // "Night 3 kill") opens buried beneath the always-on headline markets, off-screen. Paired with the
  // scroll-to-top effect below so the freshly-hoisted, auto-expanded market is actually in view.
  if (windowKey) {
    const i = markets.findIndex((mk) => mk.key === windowKey);
    if (i > 0) markets.unshift(markets.splice(i, 1)[0]!);
  }
  const defaultKey = (markets.find((mk) => mk.canClaim) ?? markets.find((mk) => mk.bettable) ?? markets[0])?.key ?? null;
  const effectiveOpen =
    windowKey && markets.some((mk) => mk.key === windowKey)
      ? windowKey
      : openKey === "__none__"
        ? null
        : openKey && markets.some((mk) => mk.key === openKey)
          ? openKey
          : defaultKey;
  const toggle = (key: string) => setOpenKey(key === effectiveOpen ? "__none__" : key);

  // Clear the staged pick whenever the open market changes.
  useEffect(() => setPicked(null), [effectiveOpen]);

  // When a betting window opens, snap the list back to the top so its freshly-hoisted, auto-expanded
  // market is in view (it may have been scrolled past). Keyed on windowKey → fires once per window.
  useEffect(() => {
    if (windowKey) listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [windowKey]);

  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  const maxStake = balance != null ? Math.max(0, balance) : null;
  // Stepper: nudge the stake by a magnitude-scaled increment, clamped to [0, balance].
  const stepStake = (dir: number) => {
    const v = parseFloat(amount) || 0;
    const inc = v < 0.1 ? 0.01 : v < 1 ? 0.1 : 1;
    let next = v + dir * inc;
    if (next < 0) next = 0;
    if (maxStake != null && next > maxStake) next = maxStake;
    setAmount(String(Number(next.toFixed(3))));
  };

  const isRefundOutcome = factionVoid;

  // Portfolio roll-up across every market the wallet holds a position in.
  const myPositions = markets.filter((mk) => mk.myStake > 0);
  const portfolioStaked = myPositions.reduce((acc, mk) => acc + mk.myStake, 0);
  const portfolioWin = myPositions.reduce((acc, mk) => acc + mk.myProjWin, 0);

  return (
    <aside className="panel flex h-full min-h-0 flex-col overflow-hidden px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-0">Wagers&#x20;
        <StateBadge s={s} />
      </div>

      {/* Pre-match betting hold — a fresh case has convened and betting is open before the first night. A
          visible countdown makes the new round unmistakable (not an instant cut to nightfall) and gives real
          time to back the headline markets. Only before the first beat lands. */}
      {preMatchOpen && (
        <div className="mb-4 border-l-2 border-gilt bg-gilt/[0.06] px-3 py-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gilt">◈ A new case convenes</span>
            <span className="font-mono text-[20px] tabular-nums tracking-[0.08em] text-gilt">{preMatchCountdown!.label}</span>
          </div>
          <div className="mt-1 font-display text-[15px] leading-tight text-cream">Wagers open before the first night</div>
          <div className="mt-0.5 font-body text-[12px] italic leading-snug text-mute">
            back the faction verdict &amp; who&apos;s the Mafia — the first night falls when the clock runs out
          </div>
        </div>
      )}

      {/* Betting-window ribbon — the match is paused on a dramatic beat and this market is spotlighted
          (auto-expanded below, where its question + outcomes live). Kept to a single urgent line: the
          question isn't repeated here since the spotlighted market shows it right below, and the stage
          already frames it. Turns urgent as it closes. */}
      {s.betWindow && windowCountdown && (
        <div
          className={[
            "mb-3 flex items-center justify-between gap-3 border-l-2 px-3 py-2 transition-colors",
            windowClosing ? "border-convict bg-convict/[0.07]" : "border-gilt bg-gilt/[0.06]",
          ].join(" ")}
        >
          <span className={["flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em]", windowClosing ? "text-convict" : "text-gilt"].join(" ")}>
            <span className={["h-1.5 w-1.5 animate-livepulse rounded-full", windowClosing ? "bg-convict" : "bg-gilt"].join(" ")} />
            {windowClosing ? "Closing" : "Betting window"}
          </span>
          <span
            className={[
              "font-mono text-[20px] tabular-nums tracking-[0.08em]",
              windowClosing ? "animate-livepulse text-convict" : "text-gilt",
            ].join(" ")}
          >
            {windowCountdown.label}
          </span>
        </div>
      )}

      {/* Live betting countdown — the always-open faction market's close time. Suppressed while a
          spotlighted window (or the pre-match hold) owns the countdown, so two strips never stack. */}
      {live && countdown && !s.betWindow && !preMatchOpen && (
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
          {factionVoid
            ? "No verdict settled on the faction market — a mistrial, or no wager backed the winner. Every stake is returned in full."
            : "The match was abandoned before settlement. Reclaim your full stake on any market you backed."}
        </div>
      )}

      {/* ── Your book — a slim roll-up of where your money sits, across every market. Shares the
          left-accent strip treatment with the countdowns so the panel reads as one quiet column. ── */}
      {connected && myPositions.length > 0 && (
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-l-2 border-gilt/40 bg-gilt/[0.035] px-3 py-2 font-mono">
          <span className="text-[10px] uppercase tracking-[0.18em] text-gilt">
            Your book <span className="text-mute">· {myPositions.length} {myPositions.length === 1 ? "market" : "markets"}</span>
          </span>
          <span className="flex items-baseline gap-2 tabular-nums">
            <span className="text-[9.5px] uppercase tracking-[0.1em] text-mute">staked</span>
            <span className="text-[13.5px] text-cream">◈{portfolioStaked.toFixed(2)}</span>
            <span className="text-mute-2">→</span>
            <span className="text-[9.5px] uppercase tracking-[0.1em] text-mute">to win</span>
            <span className="text-[13.5px] text-acquit">◈{portfolioWin.toFixed(2)}</span>
          </span>
        </div>
      )}

      {/* ── The market list — every bet on the table, scannable. Tap a row to expand one. ── */}
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
            connectBurner={connectBurner}
            amount={amount}
            setAmount={setAmount}
            stepStake={stepStake}
            balance={balance}
            gasless={api.gasless}
            getTestTokens={mint}
            minting={minting}
          />
        ))}
      </div>

      {/* ── Slim global footer: cross-market wallet identity + on-chain receipts. ── */}
      {(s.tx.error || s.tx.lastHash || s.settleTxHash) && (
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
        </div>
      )}
    </aside>
  );
}
