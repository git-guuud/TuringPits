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

/**
 * A 0..1 progress fraction for the single header countdown, without any server-supplied duration: the
 * first (largest) `ms` seen for a countdown identity becomes the denominator, so the bar starts full and
 * eases down as the clock runs. Keyed so a fresh countdown (new window / round) resets the bar. Mutating
 * the ref in render is safe here — it's a pure max() over the current key.
 */
function useCountdownProgress(key: string | null, ms: number | null): number {
  const peak = useRef<{ key: string | null; max: number }>({ key: null, max: 0 });
  if (key !== peak.current.key) peak.current = { key, max: ms ?? 0 };
  if (ms != null && ms > peak.current.max) peak.current.max = ms;
  if (ms == null || peak.current.max <= 0) return 0;
  return Math.max(0, Math.min(1, ms / peak.current.max));
}

// ── per-UI-state chrome: badge word + left-accent + badge/title colours ──────────
// A market is classified into one of these from its live view-model (bettable / claimable / pill), and
// the whole row (accent stripe, badge, title, recede) is driven off the match.
type UiState = "window" | "open" | "claim" | "soon" | "settled" | "sealed" | "void";
const UI: Record<UiState, { badge: string; left: string; badgeCls: string; titleCls: string; dim: boolean }> = {
  window: { badge: "WINDOW", left: "border-l-convict", badgeCls: "text-convict border-convict/60", titleCls: "text-cream", dim: false },
  open: { badge: "OPEN", left: "border-l-gilt", badgeCls: "text-gilt border-gilt/50", titleCls: "text-cream", dim: false },
  claim: { badge: "CLAIM", left: "border-l-acquit", badgeCls: "text-acquit border-acquit/50", titleCls: "text-cream", dim: false },
  soon: { badge: "SOON", left: "border-l-mute", badgeCls: "text-mute border-line-2", titleCls: "text-cream-dim", dim: true },
  settled: { badge: "SETTLED", left: "border-l-acquit/50", badgeCls: "text-acquit/70 border-acquit/30", titleCls: "text-cream-dim", dim: false },
  sealed: { badge: "SEALED", left: "border-l-mute-2", badgeCls: "text-mute border-line-2", titleCls: "text-mute", dim: true },
  void: { badge: "RETURNED", left: "border-l-gilt/50", badgeCls: "text-gilt/70 border-gilt/30", titleCls: "text-mute", dim: true },
};

// Nightfall dims the Wagers panel by SHIFTING its own surface colours to a cool moonlight palette
// (the veil is lifted off this panel in Live.tsx, so a slab is never laid over the betting UI). Every
// opaque surface has a warm day value and a cool night value; the swap cross-fades via transition-colors.
const DAY = { panel: "#131009", header: "#131009", raised: "#1b1610", list: "#0f0c07", action: "#100d07", footer: "#0c0b08" } as const;
const NIGHT = { panel: "#0e1322", header: "#101527", raised: "#182036", list: "#0b1020", action: "#0c1526", footer: "#080c18" } as const;

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

/** A wide two-up card — used only for the ≤2-outcome markets, where each side gets room to breathe. */
function OutcomeCard({
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
  const hasPool = parseFloat(c.total) > 0;
  const m = mult(c.pool, c.total);
  // Precise pot fraction (not the rounded %) drives the bar + the flash, so even a sub-1% move registers.
  const frac = parseFloat(c.total) > 0 ? (parseFloat(c.pool) / parseFloat(c.total)) * 100 : 0;
  const dir = useValueFlash(Math.round(frac * 10) / 10);
  const flash = dir === "up" ? "animate-flashup text-acquit" : dir === "down" ? "animate-flashdown text-convict" : "text-cream";
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={[
        "relative border-l-2 px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-l-gilt bg-gilt/[0.07]"
          : c.winner
            ? "border-l-acquit bg-acquit/[0.04]"
            : c.mine > 0
              ? "border-l-gilt/50 bg-gilt/[0.03]"
              : "border-l-line",
        selectable ? "cursor-pointer hover:bg-gilt/[0.05]" : "cursor-default",
        dimmed ? "opacity-45" : "",
      ].join(" ")}
    >
      {c.winner && (
        <span className="absolute right-1.5 top-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-acquit">● outcome</span>
      )}
      <div className={["truncate font-mono text-[9px] uppercase tracking-[0.2em]", c.eyebrowClass].join(" ")}>{c.eyebrow}</div>
      <div className={["mt-0.5 font-display text-[22px] font-semibold leading-none tracking-[0.02em]", selected ? "text-lamp" : c.accent].join(" ")}>{c.label}</div>
      {hasPool ? (
        <>
          <div className="mt-2.5 flex items-baseline gap-1.5">
            <span className={["rounded-[1px] px-1 font-mono text-[22px] font-semibold leading-none tabular-nums", flash].join(" ")}>{m}</span>
            {dir && <span className={["text-[9px]", dir === "up" ? "text-acquit" : "text-convict"].join(" ")}>{dir === "up" ? "▲" : "▼"}</span>}
          </div>
          <div className="mt-2 flex items-center justify-between font-mono text-[10px] tabular-nums text-mute">
            <span>{pct(c.pool, c.total)}% of pot</span>
            <span>◈{parseFloat(c.pool).toFixed(2)}</span>
          </div>
          <div className="mt-2 h-0.5 bg-line">
            <div className={["h-full transition-[width] duration-500 ease-out", selected ? "bg-gilt" : "bg-gilt-soft"].join(" ")} style={{ width: `${Math.min(100, frac).toFixed(1)}%` }} />
          </div>
        </>
      ) : (
        <div className="mt-2 font-mono text-[10px] tracking-[0.08em] text-mute-2">no wagers yet</div>
      )}
      {c.mine > 0 && (
        <div className="mt-2.5 border-l-2 border-gilt pl-1.5 font-mono text-[9.5px] tracking-[0.06em] text-gilt">
          ◈{c.mine.toFixed(2)} yours{c.winner ? ` · pays ◈${existingWin(c.mine, c.pool, c.total).toFixed(2)}` : ""}
        </div>
      )}
    </button>
  );
}

/** A slim single-line row — used for the many-outcome markets (seats / fate), inside an internal scroll. */
function OutcomeRow({
  c,
  selected,
  selectable,
  onSelect,
}: {
  c: Choice;
  selected: boolean;
  selectable: boolean;
  onSelect: () => void;
}) {
  const m = mult(c.pool, c.total);
  const frac = parseFloat(c.total) > 0 ? (parseFloat(c.pool) / parseFloat(c.total)) * 100 : 0;
  const dir = useValueFlash(Math.round(frac * 10) / 10);
  const flash = dir === "up" ? "animate-flashup text-acquit" : dir === "down" ? "animate-flashdown text-convict" : "text-cream";
  return (
    <button
      type="button"
      disabled={!selectable}
      onClick={onSelect}
      className={[
        "relative flex w-full items-center justify-between gap-2.5 overflow-hidden border-b border-l-2 hairline px-2.5 py-2 text-left transition-colors",
        selected ? "border-l-gilt bg-gilt/[0.07]" : c.mine > 0 ? "border-l-gilt/40" : "border-l-transparent",
        selectable ? "cursor-pointer hover:bg-gilt/[0.05]" : "cursor-default",
      ].join(" ")}
    >
      <span aria-hidden className="absolute bottom-0 left-0 h-0.5" style={{ width: `${Math.min(100, frac).toFixed(1)}%`, background: selected ? "#c9a23f" : "#9c8038" }} />
      <span className="relative flex min-w-0 items-center gap-2.5">
        <span className="w-11 shrink-0 font-mono text-[9px] uppercase tracking-[0.12em] text-mute-2">{c.eyebrow}</span>
        <span className={["truncate font-display text-[18px] font-medium leading-none", selected ? "text-lamp" : c.winner ? "text-acquit" : "text-cream"].join(" ")}>{c.label}</span>
        {c.mine > 0 && <span className="shrink-0 border-l-2 border-gilt pl-1.5 font-mono text-[8.5px] text-gilt">◈{c.mine.toFixed(2)}</span>}
        {c.winner && <span className="shrink-0 font-mono text-[8px] text-acquit">● out</span>}
      </span>
      <span className="relative flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
        <span className="text-[9.5px] text-mute">{pct(c.pool, c.total)}% · ◈{parseFloat(c.pool).toFixed(2)}</span>
        <span className={["rounded-[1px] px-1 text-[13px] font-semibold", flash].join(" ")}>{m}</span>
      </span>
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

/** Classify a live market into the UI-state that drives its badge / accent / recede treatment. */
function uiStateOf(m: BetMarket, isWindow: boolean): UiState {
  if (m.canClaim) return "claim";
  if (m.bettable) return isWindow ? "window" : "open";
  switch (m.pill.text) {
    case "soon":
      return "soon";
    case "returned":
      return "void";
    case "collected":
    case "missed":
    case "settled":
      return "settled";
    default:
      return "sealed";
  }
}

// PlayerFate death-round buckets (MafiaMarket.FATE_BUCKETS == 5), in outcome order.
const FATE_COPY: ReadonlyArray<Pick<Choice, "eyebrow" | "eyebrowClass" | "label" | "accent" | "bar">> = [
  { eyebrow: "to the final bell", eyebrowClass: "text-acquit", label: "SURVIVES", accent: "text-acquit", bar: "bg-acquit" },
  { eyebrow: "first to fall", eyebrowClass: "text-convict", label: "OUT · R1", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "second round", eyebrowClass: "text-convict", label: "OUT · R2", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "third round", eyebrowClass: "text-convict", label: "OUT · R3", accent: "text-convict", bar: "bg-convict" },
  { eyebrow: "the long game", eyebrowClass: "text-convict", label: "OUT · R4+", accent: "text-convict", bar: "bg-convict" },
];

// ── a single market in the at-a-glance list: collapsed header + (when open) inline outcomes ──
function MarketRow({
  m,
  expanded,
  onToggle,
  picked,
  setPicked,
  busy,
  isWindow,
  miniCountdown,
  night,
}: {
  m: BetMarket;
  expanded: boolean;
  onToggle: () => void;
  picked: string | null;
  setPicked: (k: string) => void;
  busy: boolean;
  /** This is the market a betting window is spotlighting — colours the fav peek + shows a mini clock. */
  isWindow: boolean;
  miniCountdown: string | null;
  /** Nightfall — cool the expanded surfaces to moonlight. */
  night: boolean;
}) {
  const surf = night ? NIGHT : DAY;
  const ui = UI[uiStateOf(m, isWindow)];
  const fav = m.choices.length ? m.choices.reduce((a, b) => (parseFloat(b.pool) > parseFloat(a.pool) ? b : a)) : null;
  const winner = m.choices.find((c) => c.winner) ?? null;
  const potTotal = m.choices.length ? m.choices[0]!.total : "0";
  const potDir = useValueFlash(Math.round(parseFloat(potTotal) * 100) / 100);

  // Two outcome layouts: ≤2 gets wide side-by-side cards; more gets a compact internal-scroll list, so a
  // 7-seat market never balloons the panel and the pinned action bar stays a tap away without scrolling.
  const big = m.choices.length <= 2;

  const claimVerb = m.claimLabel.toLowerCase().startsWith("reclaim") ? "RECLAIM" : "CLAIM";
  const claimAmt = claimVerb === "CLAIM" ? m.myProjWin : m.myStake;

  // Collapsed "peek" chips — the at-a-glance line under the title. Live markets read pot / fav / your
  // position; resolved ones read the outcome + a claim or a terse status.
  const chips: { t: string; cls: string }[] = [];
  if (m.canClaim) {
    chips.push({ t: `● ${winner ? winner.label : "stake returned"}`, cls: "text-cream-dim" });
    chips.push({ t: `${claimVerb} ◈${claimAmt.toFixed(2)}`, cls: "text-acquit" });
  } else if (m.bettable && fav) {
    chips.push({ t: `◈${parseFloat(potTotal).toFixed(2)}`, cls: potDir === "up" ? "text-acquit" : potDir === "down" ? "text-convict" : "text-mute" });
    chips.push({ t: `${fav.label} ${mult(fav.pool, fav.total)}`, cls: isWindow ? "text-lamp" : "text-cream" });
    if (m.myStake > 0) chips.push({ t: `you ◈${m.myStake.toFixed(2)}`, cls: "border-l-2 border-gilt pl-1.5 text-gilt" });
  } else if (winner) {
    chips.push({ t: `● ${winner.label}`, cls: "text-cream-dim" });
    chips.push({ t: m.pill.text, cls: "text-mute" });
  } else {
    const s = (m.status ?? "").replace(/[🔒]/g, "").trim();
    chips.push({ t: s || m.pill.text, cls: "text-mute" });
  }

  return (
    <div
      className={["border-b border-l-2 hairline transition-colors duration-[1400ms]", ui.left].join(" ")}
      style={{ backgroundColor: expanded ? surf.raised : "transparent" }}
    >
      {/* ── Collapsed header — badge, title, (window clock), chevron, and a peek line. Tap to expand. ── */}
      <button
        type="button"
        onClick={onToggle}
        className={["flex w-full flex-col gap-1.5 px-3 py-2.5 text-left transition-opacity", ui.dim && !expanded ? "opacity-55 hover:opacity-90" : ""].join(" ")}
      >
        <div className="flex items-center gap-2.5">
          <span className={["shrink-0 border px-[5px] py-[1.5px] font-mono text-[8.5px] uppercase tracking-[0.16em]", ui.badgeCls].join(" ")}>{ui.badge}</span>
          <span className={["min-w-0 flex-1 truncate font-display text-[19px] font-medium leading-none", ui.titleCls].join(" ")}>{m.title}</span>
          {miniCountdown && (
            <span className="shrink-0 border-l-2 border-convict pl-1.5 font-mono text-[11px] font-semibold tabular-nums text-lamp">{miniCountdown}</span>
          )}
          <motion.span
            aria-hidden
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={{ duration: 0.24, ease: "easeInOut" }}
            className="inline-block w-3 shrink-0 text-center font-mono text-[11px] leading-none text-mute"
          >
            ▸
          </motion.span>
        </div>
        {!expanded && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums">
            {chips.map((c, i) => (
              <span key={i} className={c.cls}>{c.t}</span>
            ))}
          </div>
        )}
      </button>

      {/* ── Expanded body — the question and its outcomes. The stake+confirm lives in the pinned bar. ── */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3">
              <div className="mb-2.5 font-display text-[17px] italic leading-tight text-cream-dim">{m.question}</div>
              {big ? (
                <div className="grid grid-cols-2 gap-2">
                  {m.choices.map((c) => (
                    <OutcomeCard
                      key={c.key}
                      c={c}
                      selected={picked === c.key}
                      selectable={m.bettable && !busy}
                      dimmed={!m.bettable && !c.winner}
                      onSelect={() => setPicked(c.key)}
                    />
                  ))}
                </div>
              ) : (
                <div className="max-h-[min(46vh,340px)] overflow-y-auto border hairline transition-colors duration-[1400ms] [scrollbar-width:thin]" style={{ backgroundColor: surf.list }}>
                  {m.choices.map((c) => (
                    <OutcomeRow
                      key={c.key}
                      c={c}
                      selected={picked === c.key}
                      selectable={m.bettable && !busy}
                      onSelect={() => setPicked(c.key)}
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── the pinned action bar on the panel floor: pick summary + the one wager / claim / connect action ──
function ActionBar({
  m,
  picked,
  amount,
  setAmount,
  stepStake,
  busy,
  connected,
  connecting,
  connect,
  connectBurner,
  balance,
  gasless,
  getTestTokens,
  minting,
  night,
}: {
  m: BetMarket;
  picked: string | null;
  amount: string;
  setAmount: (a: string) => void;
  stepStake: (dir: number) => void;
  busy: boolean;
  connected: boolean;
  connecting: boolean;
  connect: () => void;
  connectBurner: () => void;
  balance: number | null;
  gasless: boolean;
  getTestTokens: () => void;
  minting: boolean;
  night: boolean;
}) {
  const stakeNum = parseFloat(amount) || 0;
  const pickedChoice = picked ? m.choices.find((c) => c.key === picked) ?? null : null;
  const projWin = pickedChoice ? projectWin(stakeNum, pickedChoice.pool, pickedChoice.total) : null;
  const exceeds = connected && balance != null && stakeNum > balance;
  const canWager = !!picked && !busy && stakeNum > 0 && !exceeds;

  const claimVerb = m.claimLabel.toLowerCase().startsWith("reclaim") ? "RECLAIM" : "CLAIM";
  const claimAmt = claimVerb === "CLAIM" ? m.myProjWin : m.myStake;
  const winner = m.choices.find((c) => c.winner) ?? null;

  // The summary line (pick + payout) shown above whatever control the state calls for.
  let pre: string;
  let word: string;
  let wordCls: string;
  let multStr: string | null = null;
  let payLabel: string | null;
  let pay: number;
  let payCls: string;
  if (m.canClaim) {
    pre = "READY TO CLAIM";
    word = winner ? winner.label : "STAKE RETURNED";
    wordCls = "text-acquit";
    payLabel = "PAYOUT";
    pay = claimAmt;
    payCls = "text-acquit";
  } else {
    pre = "BET ON";
    word = pickedChoice?.label ?? "—";
    wordCls = "text-cream";
    multStr = pickedChoice ? mult(pickedChoice.pool, pickedChoice.total) : null;
    payLabel = m.bettable ? "CAN WIN" : null;
    pay = projWin ?? 0;
    payCls = "text-gilt";
  }

  return (
    <div className="flex-none border-t border-gilt px-4 py-3 shadow-[0_-14px_24px_-18px_rgba(0,0,0,0.9)] transition-colors duration-[1400ms]" style={{ backgroundColor: night ? NIGHT.action : DAY.action }}>
      <div className="mb-2 flex items-baseline justify-between gap-2.5">
        <div className="min-w-0 truncate">
          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-mute">{pre} </span>
          <span className={["font-display text-[18px] font-semibold", wordCls].join(" ")}>{word}</span>
          {multStr && <span className="ml-1.5 font-mono text-[12px] tabular-nums text-cream-dim">{multStr}</span>}
          {gasless && m.bettable && connected && <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gilt/70">· no gas</span>}
        </div>
        {payLabel && pay > 0 && (
          <div className="shrink-0 text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-mute-2">{payLabel}</div>
            <div className={["font-mono text-[16px] font-semibold tabular-nums", payCls].join(" ")}>◈{pay.toFixed(2)}</div>
          </div>
        )}
      </div>

      {m.canClaim ? (
        <button
          type="button"
          onClick={m.doClaim}
          disabled={busy}
          className="h-11 w-full bg-acquit font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:brightness-110 disabled:opacity-60"
        >
          {busy ? "Confirming transaction…" : `${claimVerb} ◈${claimAmt.toFixed(2)}`}
        </button>
      ) : m.bettable ? (
        !connected ? (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy}
              className="h-[42px] flex-1 bg-gilt font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-ink transition hover:brightness-110 disabled:opacity-60"
            >
              {connecting ? "Connecting…" : "Connect wallet"}
            </button>
            <button
              type="button"
              onClick={() => void connectBurner()}
              disabled={busy}
              className="shrink-0 font-mono text-[10.5px] tracking-[0.04em] text-mute transition-colors hover:text-gilt disabled:opacity-60"
            >
              Play as guest →
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-stretch gap-2">
              <div className="flex items-center border border-line-2 bg-ink">
                <button
                  type="button"
                  aria-label="Decrease stake"
                  onClick={() => stepStake(-1)}
                  className="h-[42px] w-[34px] border-r hairline font-mono text-[17px] leading-none text-cream-dim transition-colors hover:bg-gilt/[0.06] hover:text-gilt"
                >
                  −
                </button>
                <input
                  inputMode="decimal"
                  aria-label="Stake amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-[76px] bg-transparent text-center font-mono text-[15px] tabular-nums text-cream outline-none focus:text-lamp"
                />
                <button
                  type="button"
                  aria-label="Increase stake"
                  onClick={() => stepStake(1)}
                  className="h-[42px] w-[34px] border-l hairline font-mono text-[17px] leading-none text-cream-dim transition-colors hover:bg-gilt/[0.06] hover:text-gilt"
                >
                  +
                </button>
              </div>
              <button
                type="button"
                disabled={!canWager}
                onClick={() => picked && m.place(picked)}
                className={[
                  "h-[42px] flex-1 font-mono text-[12px] font-semibold uppercase tracking-[0.14em] transition",
                  canWager ? "bg-gilt text-ink hover:brightness-110" : "border border-line-2 text-mute-2",
                ].join(" ")}
              >
                {busy
                  ? "Confirming…"
                  : !picked
                    ? "Choose an option"
                    : !(stakeNum > 0)
                      ? "Enter an amount"
                      : exceeds
                        ? "Over balance"
                        : `Place bet ◈${stakeNum.toFixed(2)}`}
              </button>
            </div>
            {(exceeds || minting) && (
              <div className="mt-2 flex items-center justify-between gap-2 border-l-2 border-lamp pl-2">
                <span className="font-mono text-[9.5px] tracking-[0.06em] text-mute">
                  {connected && balance != null ? `balance ◈${balance.toFixed(2)}` : "low balance"}
                </span>
                <button
                  type="button"
                  onClick={getTestTokens}
                  disabled={busy}
                  className="font-mono text-[10px] uppercase tracking-[0.1em] text-lamp transition-colors hover:text-cream disabled:opacity-60"
                >
                  {minting ? "Minting…" : "Get test CHIP →"}
                </button>
              </div>
            )}
          </>
        )
      ) : (
        <div className="border border-line py-2.5 text-center font-mono text-[11px] uppercase tracking-[0.12em] text-mute">{m.status ?? "—"}</div>
      )}
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
  // Nightfall cools THIS panel's own surfaces (the moonlight veil is lifted off it in Live.tsx). The lamp
  // goes out and the theme shifts cold — instead of a slab laid over the betting UI. Cross-fades over 1.4s.
  const night = s.phase === "night";
  const surf = night ? NIGHT : DAY;

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
    const myStakeFor = (o: number) => (mine ? parseFloat(mine.stakes[o] ?? "0") : 0);
    // The book renders purely from the AUTHORITATIVE pools — no optimistic overlay. A wager moves the odds
    // only when the real pool push lands (the moment every spectator sees it), so the bar eases + flashes on
    // genuine money movement instead of jumping on the local click and then reconciling back.
    const pools = prop.pools;
    const total = pools.reduce((acc, p) => acc + parseFloat(p), 0).toString();
    const myTotalStake = pools.reduce((acc, _p, o) => acc + myStakeFor(o), 0);
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
      title = "Faction win";
      question = "Will Mafia win?";
      choices = [
        {
          key: "o1", eyebrow: "Mafia faction", eyebrowClass: "text-[#d98a55]",
          label: "ACQUITTED", accent: "text-[#d98a55]", bar: "bg-[#d98a55]",
          pool: pools[1] ?? "0", total, mine: myStakeFor(1), winner: win === 1,
        },
        {
          key: "o0", eyebrow: "Town faction", eyebrowClass: "text-acquit",
          label: "CONVICTED", accent: "text-acquit", bar: "bg-acquit",
          pool: pools[0] ?? "0", total, mine: myStakeFor(0), winner: win === 0,
        },
      ];
    } else if (prop.kind === "PLAYER_FATE") {
      const name = seatName(prop.param);
      title = `${name} · fate`;
      question = `What happens to ${name}?`;
      choices = FATE_COPY.map((copy, o) => ({
        key: `o${o}`,
        ...copy,
        pool: pools[o] ?? "0",
        total,
        mine: myStakeFor(o),
        winner: win === o,
      }));
    } else if (prop.kind === "DETECTIVE_CLAIM") {
      // Binary reveal fork — outcome 1 = REAL DETECTIVE, 0 = BLUFF. Keyed to the claiming seat; it
      // resolves from the revealed roles at settle. REAL first (the claim as stated), then BLUFF.
      const name = seatName(prop.param);
      title = `${name} · claim`;
      question = `Is ${name}'s Detective claim real?`;
      choices = [
        {
          key: "o1", eyebrow: "real detective", eyebrowClass: "text-acquit",
          label: "REAL", accent: "text-acquit", bar: "bg-acquit",
          pool: pools[1] ?? "0", total, mine: myStakeFor(1), winner: win === 1,
        },
        {
          key: "o0", eyebrow: "fake claim", eyebrowClass: "text-convict",
          label: "BLUFF", accent: "text-convict", bar: "bg-convict",
          pool: pools[0] ?? "0", total, mine: myStakeFor(0), winner: win === 0,
        },
      ];
    } else if (prop.kind === "MAFIA_SEAT") {
      // "Who is the Mafia?" — one outcome per seat, resolved to the Mafia seat from the revealed roles at
      // settle. A dead seat can still be unmasked as the Mafia, so every seat stays shown the whole match.
      title = "Who is Mafia?";
      question = "Which player is Mafia?";
      choices = [];
      for (let seat = 0; seat < prop.numOutcomes; seat++) {
        choices.push({
          key: `o${seat}`,
          eyebrow: `seat ${seat + 1}`,
          eyebrowClass: "text-convict",
          label: seatName(seat),
          accent: "text-convict",
          bar: "bg-convict",
          pool: pools[seat] ?? "0",
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
      const noOne = prop.numOutcomes - 1; // the last outcome — no one / a quiet night
      title = isNight ? `Night ${r} kill` : `Round ${r} vote`;
      question = isNight ? `Who is killed in night ${r}?` : `Who is voted out in round ${r}?`;
      choices = [];
      for (let seat = 0; seat < noOne; seat++) {
        const aliveNow = aliveBySeat.get(seat) ?? true;
        const seatPool = parseFloat(pools[seat] ?? "0");
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
          pool: pools[seat] ?? "0",
          total,
          mine: myStakeFor(seat),
          winner: win === seat,
        });
      }
      choices.push({
        key: `o${noOne}`,
        eyebrow: isNight ? "no kill" : "no vote",
        eyebrowClass: "text-acquit",
        label: isNight ? "NO KILL" : "NO ONE",
        accent: "text-acquit",
        bar: "bg-acquit",
        pool: pools[noOne] ?? "0",
        total,
        mine: myStakeFor(noOne),
        winner: win === noOne,
      });
    }

    const awaiting = myTotalStake > 0 ? " · awaiting settlement" : "";
    const closedText =
      prop.kind === "FACTION"
        ? `verdict in · market closed${awaiting}`
        : prop.kind === "ROUND_VOTED_OUT"
          ? `round ${prop.param} vote in · market closed${awaiting}`
          : prop.kind === "NIGHT_KILL"
            ? `night ${prop.param} ended · market closed${awaiting}`
            : prop.kind === "DETECTIVE_CLAIM"
              ? `${seatName(prop.param)}'s claim · market closed${awaiting}`
              : prop.kind === "MAFIA_SEAT"
                ? `Mafia found · market closed${awaiting}`
                : `${seatName(prop.param)} fell · market closed${awaiting}`;
    const wonStatus = isVoid
      ? "Void · stakes returned"
      : win == null
        ? "Settled"
        : prop.kind === "FACTION"
          ? win === 1
            ? "Mafia won"
            : "Town won"
          : prop.kind === "ROUND_VOTED_OUT"
            ? win === prop.numOutcomes - 1
              ? "No one was voted out"
              : `${seatName(win)} was voted out`
            : prop.kind === "NIGHT_KILL"
              ? win === prop.numOutcomes - 1
                ? "No one was killed"
                : `${seatName(win)} was killed`
              : prop.kind === "DETECTIVE_CLAIM"
                ? win === 1
                  ? `${seatName(prop.param)}'s claim was real`
                  : `${seatName(prop.param)}'s claim was false`
                : prop.kind === "MAFIA_SEAT"
                  ? `${seatName(win)} was Mafia`
                  : `Fate · ${FATE_COPY[win]?.label ?? "settled"}`;
    const status = bettable
      ? null
      : settled || refundMode
        ? claimed
          ? myWin || isVoid
            ? "Collected ✓"
            : "Settled · your prediction missed"
          : wonStatus
        : decided && open
          ? closedText
          : preOpen
            ? "Market open soon"
            : "Market closed";

    const myProjWin = choices.reduce((acc, c) => acc + existingWin(c.mine, c.pool, c.total), 0);
    const pill = bettable
      ? { text: "open", cls: "text-gilt border-gilt/40" }
      : canClaim
        ? { text: "claim", cls: "text-acquit border-acquit/50" }
        : preOpen
          ? { text: "soon", cls: "text-cream-dim border-line-2" }
          : (isVoid || refundMode) && myTotalStake > 0
            ? { text: "returned", cls: "text-gilt/70 border-gilt/30" }
            : myWin
              ? { text: "collected", cls: "text-acquit/70 border-acquit/30" }
              : (settled || refundMode) && myTotalStake > 0
                ? { text: "missed", cls: "text-mute border-line-2" }
                : settled
                  ? { text: "settled", cls: "text-mute border-line-2" }
                  : { text: "sealed", cls: "text-mute border-line-2" };

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
      claimLabel: isVoid || refundMode ? "Reclaim stake" : "Claim",
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
  // A betting window auto-expands its market ONCE when it opens (see the effect below) instead of pinning
  // the panel to it — after that the spectator can collapse it or open another market freely while the
  // window's clock still runs. The expansion is just a normal `openKey`, so the user's toggle always wins.
  const effectiveOpen =
    openKey === "__none__"
      ? null
      : openKey && markets.some((mk) => mk.key === openKey)
        ? openKey
        : defaultKey;
  const toggle = (key: string) => setOpenKey(key === effectiveOpen ? "__none__" : key);
  const openMarket = markets.find((mk) => mk.key === effectiveOpen) ?? null;

  // Default the staged pick to the open market's favourite (largest pool) so the pinned action bar always
  // previews a real payout the instant a market opens. Re-runs only when the open market changes — a live
  // odds shift never yanks the user's chosen outcome out from under them.
  useEffect(() => {
    const mk = markets.find((x) => x.key === effectiveOpen);
    if (!mk || mk.choices.length === 0) {
      setPicked(null);
      return;
    }
    const fav = mk.choices.reduce((a, b) => (parseFloat(b.pool) > parseFloat(a.pool) ? b : a));
    setPicked(fav.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveOpen]);

  // When a betting window opens, expand its market and snap the list back to the top so the freshly-
  // hoisted market is in view (it may have been scrolled past) — ONCE. After that the spectator can
  // collapse it or open another market freely; the window no longer holds the panel on its market until
  // the clock runs out. Keyed on windowKey → fires once per window.
  useEffect(() => {
    if (windowKey) {
      setOpenKey(windowKey);
      listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }
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

  // Portfolio roll-up across every market the wallet holds a position in (inlined into the header).
  const myPositions = markets.filter((mk) => mk.myStake > 0);
  const portfolioStaked = myPositions.reduce((acc, mk) => acc + mk.myStake, 0);
  const portfolioWin = myPositions.reduce((acc, mk) => acc + mk.myProjWin, 0);
  const showBook = connected && myPositions.length > 0;

  // ── The single active header countdown — one of the window / pre-match / close clocks, never stacked. ──
  const activeCd =
    s.betWindow && windowCountdown
      ? { key: `w-${windowKey}`, label: windowClosing ? "Closing" : "Betting window", time: windowCountdown.label, ms: windowCountdown.ms, urgent: windowClosing }
      : preMatchOpen && preMatchCountdown
        ? { key: "prematch", label: "First night in", time: preMatchCountdown.label, ms: preMatchCountdown.ms, urgent: false }
        : live && countdown
          ? { key: "close", label: closingSoon ? "Closing" : "Market close in", time: countdown.label, ms: countdown.ms, urgent: closingSoon }
          : null;
  const cdProgress = useCountdownProgress(activeCd?.key ?? null, activeCd?.ms ?? null);

  // The header status word + lamp — a live pulse while betting, a steady tint once resolved.
  const caseId = s.matchId != null ? `#${s.matchId}` : "";
  const headStatus = live
    ? { label: `Live · Case ${caseId} · R${Math.max(1, s.round)}`, dot: "bg-lamp animate-lamppulse" }
    : preOpen || preMatchOpen
      ? { label: `Case ${caseId} · starting`, dot: "bg-mute" }
      : refundMode
        ? { label: `Case ${caseId} · abandoned`, dot: "bg-gilt" }
        : settled
          ? { label: `Case ${caseId} · ${factionVoid ? "no verdict" : "settled"}`, dot: "bg-acquit" }
          : { label: `Case ${caseId} · sealed`, dot: "bg-mute" };

  // At night the lamp is out: the warm gilt wordmark cools to steel and the status dot stops pulsing.
  const dotCls = night ? "bg-[#5b6d9e]" : headStatus.dot;

  return (
    <aside className="panel flex h-full min-h-0 flex-col overflow-hidden transition-colors duration-[1400ms]" style={{ backgroundColor: surf.panel }}>
      {/* ── Compact header — the WAGERS mark + case status, the "your book" roll-up, and the one active
          countdown with a thin progress bar. Everything that used to stack as separate ribbons lives here. ── */}
      <div className="flex-none border-b hairline px-4 py-3 transition-colors duration-[1400ms]" style={{ backgroundColor: surf.header }}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className={["h-1.5 w-1.5 shrink-0 rounded-full transition-colors duration-700", dotCls].join(" ")} />
            <span className={["shrink-0 font-mono text-[12px] font-semibold uppercase tracking-[0.26em] transition-colors duration-[1400ms]", night ? "text-[#9fb2e0]" : "text-gilt"].join(" ")}>Markets</span>
            <span className="truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-mute">{headStatus.label}</span>
          </div>
          {showBook && (
            <div className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
              <span className="text-[9px] uppercase tracking-[0.16em] text-mute-2">your holding</span>
              <span className="text-[12px] text-cream-dim">◈{portfolioStaked.toFixed(2)}</span>
              <span className="text-mute-2">→</span>
              <span className="text-[12px] text-gilt">◈{portfolioWin.toFixed(2)}</span>
            </div>
          )}
        </div>

        {activeCd && (
          <div className={["mt-2.5 border-l-2 pl-2.5", activeCd.urgent ? "border-convict" : "border-gilt"].join(" ")}>
            <div className="flex items-center justify-between gap-2.5">
              <span className={["font-mono text-[9.5px] uppercase tracking-[0.2em]", activeCd.urgent ? "text-convict" : "text-gilt"].join(" ")}>{activeCd.label}</span>
              <span className={["font-mono text-[15px] font-semibold tabular-nums tracking-[0.08em]", activeCd.urgent ? "animate-livepulse text-convict" : "text-gilt"].join(" ")}>{activeCd.time}</span>
            </div>
            <div className="mt-1.5 h-0.5 bg-line">
              <div className={["h-full transition-[width] duration-500 ease-linear", activeCd.urgent ? "bg-convict" : "bg-gilt"].join(" ")} style={{ width: `${(cdProgress * 100).toFixed(1)}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* A single slim note only when every stake is being returned — the per-market "RETURNED" badges and
          the reclaim actions carry the rest, so this stays one line instead of a stacked banner. */}
      {(refundMode || factionVoid) && (
        <div className="flex-none border-b border-l-2 border-gilt/50 hairline bg-gilt/[0.04] px-4 py-2 font-body text-[12px] italic leading-snug text-cream-dim">
          {factionVoid
            ? "No result was backed on the faction market. Every stake is returned."
            : "The match ended before settlement. Claim back your full stake on any market you backed."}
        </div>
      )}

      {/* ── The market list — every bet on the table, scannable. Tap a row to expand one. ── */}
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {markets.map((mk) => (
          <MarketRow
            key={mk.key}
            m={mk}
            expanded={mk.key === effectiveOpen}
            onToggle={() => toggle(mk.key)}
            picked={picked}
            setPicked={setPicked}
            busy={busy}
            isWindow={mk.key === windowKey}
            miniCountdown={mk.key === windowKey && windowCountdown ? windowCountdown.label : null}
            night={night}
          />
        ))}
      </div>

      {/* ── The pinned action bar — always on the panel floor, so a bet is one tap away without scrolling. ── */}
      {openMarket && (
        <ActionBar
          m={openMarket}
          picked={picked}
          amount={amount}
          setAmount={setAmount}
          stepStake={stepStake}
          busy={busy}
          connected={connected}
          connecting={s.wallet.status === "connecting"}
          connect={connect}
          connectBurner={connectBurner}
          balance={balance}
          gasless={api.gasless}
          getTestTokens={mint}
          minting={minting}
          night={night}
        />
      )}

      {/* ── Slim receipt footer: on-chain proof of the last wager/claim and the settlement. ── */}
      {(s.tx.error || s.tx.lastHash || s.settleTxHash) && (
        <div className="flex-none border-t hairline px-4 py-2 transition-colors duration-[1400ms]" style={{ backgroundColor: surf.footer }}>
          {s.tx.error && <div className="mb-1.5 text-center font-mono text-[10.5px] leading-snug text-convict">{s.tx.error}</div>}
          <div className="flex items-center justify-center gap-4 font-mono text-[9.5px] uppercase tracking-[0.1em]">
            {s.tx.lastHash && !s.tx.pending && (
              <a href={explorerTx(s.tx.lastHash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-acquit transition-colors hover:text-cream">
                ✓ Confirmed {s.tx.lastHash.slice(0, 6)}…{s.tx.lastHash.slice(-4)} <span aria-hidden>↗</span>
              </a>
            )}
            {settled && s.settleTxHash && (
              <a href={explorerTx(s.settleTxHash)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-mute transition-colors hover:text-cream">
                ⚖ Settle {s.settleTxHash.slice(0, 6)}…{s.settleTxHash.slice(-4)} <span aria-hidden>↗</span>
              </a>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
