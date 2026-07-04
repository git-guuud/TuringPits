import { useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { MatchApi, ViewState } from "../../state/matchStore.js";
import { useMusic } from "../../lib/useMusic.js";
import { useSound } from "../../lib/useSound.js";
import { useVoice } from "../../lib/useVoice.js";
import { useMediaQuery } from "../../lib/useMediaQuery.js";
import { useCountdown } from "../../lib/useCountdown.js";
import { useDialog } from "../../lib/useDialog.js";
import { navigate } from "../../lib/useRoute.js";
import { liveness, phaseTag } from "../tribunal/Masthead.js";
import { Bench } from "../tribunal/Bench.js";
import { Court } from "../tribunal/Court.js";
import { Verdict } from "../tribunal/Verdict.js";
import { Record } from "../tribunal/Record.js";

// The desktop three-pane. The bench is a fixed rail (collapsible to a sliver); the wagers panel has a
// draggable width the viewer sets, clamped so neither it nor the centre stage can be crushed; the
// Court takes whatever's left in between.
const BENCH_WIDTH = 248;
const WAGERS_DEFAULT = 408;
const WAGERS_MIN = 340;
const WAGERS_MAX = 840;

/** The live arena — the bench, the court, and the verdict, fed by the live WebSocket match. */
export function Live({ api }: { api: MatchApi }) {
  const s = api.state;
  // Two genuinely different layouts: the desktop three-pane, and the narrow stage + bottom bet dock
  // (so the wager panel is always one tap away instead of clipped off-screen below 1024px).
  const wide = useMediaQuery("(min-width: 1024px)");
  const [recordOpen, setRecordOpen] = useState(false);
  const [benchOpen, setBenchOpen] = useState(false);
  const [wagersOpen, setWagersOpen] = useState(false);
  // Desktop layout the viewer can shape: collapse the bench to reclaim its width, and drag the
  // dialogue|wagers divider to set how the remaining space is split.
  const [benchCollapsed, setBenchCollapsed] = useState(true);
  const [wagersCollapsed, setWagersCollapsed] = useState(false);
  const [wagersWidth, setWagersWidth] = useState(WAGERS_DEFAULT);
  const paneRowRef = useRef<HTMLDivElement>(null);
  const resizeWagers = (clientX: number) => {
    const rect = paneRowRef.current?.getBoundingClientRect();
    if (!rect) return;
    setWagersWidth(Math.min(WAGERS_MAX, Math.max(WAGERS_MIN, rect.right - clientX)));
  };
  // When night falls the whole arena cools to moonlight; the gilt warmth recedes until dawn.
  const night = s.phase === "night";
  const music = useMusic(night);
  const sound = useSound();
  const voice = useVoice();

  // Moonlight veil — above the panels (z-30) so it tints them, below the modals (z-50).
  const veil = (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-0 z-30 transition-opacity duration-[1400ms] ease-in-out ${
        night ? "opacity-100" : "opacity-0"
      }`}
      style={{
        background:
          "radial-gradient(900px 520px at 50% -6%, rgba(126,156,224,.20), transparent 62%)," +
          "linear-gradient(180deg, rgba(20,30,62,.34), rgba(9,14,34,.46))",
      }}
    />
  );

  const recordModal = recordOpen && <Record s={s} onClose={() => setRecordOpen(false)} />;

  // ── Desktop: the full courtroom, three panes side by side ──────────────────────
  if (wide) {
    return (
      <main className="flex h-[100dvh] w-full flex-col overflow-hidden px-6 pb-4">
        {veil}

        <DesktopHeader
          s={s}
          music={music}
          sound={sound}
          voice={voice}
          connect={api.connect}
          onOpenRecord={() => setRecordOpen(true)}
        />

        {/* THE BENCH · THE COURT · THE VERDICT — THE RECORD lives in a popup off the masthead.
            The bench collapses to a rail; the divider between the Court and the Wagers is draggable. */}
        <div ref={paneRowRef} className="mt-4 flex min-h-0 flex-1 overflow-hidden">
          {benchCollapsed ? (
            <BenchRail s={s} onExpand={() => setBenchCollapsed(false)} />
          ) : (
            <div className="relative min-h-0 shrink-0 border-r border-line" style={{ width: BENCH_WIDTH }}>
              <button
                type="button"
                onClick={() => setBenchCollapsed(true)}
                aria-label="Collapse the bench"
                title="Collapse the bench"
                className="absolute right-2 top-4 z-10 flex h-6 w-6 items-center justify-center rounded-sm border border-line-2 font-mono text-[13px] leading-none text-mute transition-colors hover:border-gilt hover:text-gilt"
              >
                «
              </button>
              <Bench s={s} />
            </div>
          )}

          <div className="min-h-0 min-w-0 flex-1">
            <Court s={s} advance={api.advance} stepBack={api.stepBack} skipToPresent={api.skipToPresent} voice={voice} />
          </div>

          {wagersCollapsed ? (
            <WagersRail s={s} onExpand={() => setWagersCollapsed(false)} />
          ) : (
            <>
              <ResizeHandle onDrag={resizeWagers} />
              <div className="relative min-h-0 shrink-0" style={{ width: wagersWidth }}>
                <button
                  type="button"
                  onClick={() => setWagersCollapsed(true)}
                  aria-label="Collapse the wagers"
                  title="Collapse the wagers"
                  className="absolute right-3 top-4 z-10 flex h-6 w-6 items-center justify-center rounded-sm border border-line-2 font-mono text-[13px] leading-none text-mute transition-colors hover:border-gilt hover:text-gilt"
                >
                  »
                </button>
                <Verdict api={api} />
              </div>
            </>
          )}
        </div>

        {recordModal}
      </main>
    );
  }

  // ── Narrow: the Court is the stage; wagers ride a bottom dock; the bench is a drawer ──
  return (
    <main className="flex h-[100dvh] w-full flex-col overflow-hidden">
      {veil}

      <MobileHeader
        s={s}
        music={music}
        sound={sound}
        voice={voice}
        onOpenBench={() => setBenchOpen(true)}
        onOpenRecord={() => setRecordOpen(true)}
      />

      <div className="min-h-0 flex-1 overflow-hidden">
        <Court s={s} advance={api.advance} stepBack={api.stepBack} skipToPresent={api.skipToPresent} voice={voice} />
      </div>

      <BottomDock s={s} onOpen={() => setWagersOpen(true)} />

      <AnimatePresence>
        {benchOpen && <BenchDrawer s={s} onClose={() => setBenchOpen(false)} />}
      </AnimatePresence>
      <AnimatePresence>
        {wagersOpen && <WagersSheet api={api} onClose={() => setWagersOpen(false)} />}
      </AnimatePresence>

      {recordModal}
    </main>
  );
}

// ── shared chrome ────────────────────────────────────────────────────────────────

/** The draggable seam between the Court (dialogue) and the Wagers panel. Pointer-captured so the drag
 *  keeps tracking even if the cursor outruns the thin handle. */
function ResizeHandle({ onDrag }: { onDrag: (clientX: number) => void }) {
  const dragging = useRef(false);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the dialogue and wagers panels"
      title="Drag to resize"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      className="group relative z-20 flex w-[3px] shrink-0 cursor-col-resize touch-none select-none items-stretch bg-line transition-colors hover:bg-gilt/40"
    >
      {/* a slightly wider invisible hit-area so the 3px seam is easy to grab */}
      <span aria-hidden className="absolute inset-y-0 -left-1.5 -right-1.5" />
      <span aria-hidden className="m-auto h-10 w-[3px] rounded bg-line-2 transition-colors group-hover:bg-gilt" />
    </div>
  );
}

/** The bench collapsed to a sliver — a vertical label + alive count that expands the full bench back. */
function BenchRail({ s, onExpand }: { s: ViewState; onExpand: () => void }) {
  const aliveCount = s.seats.filter((x) => x.alive).length;
  const total = s.seats.length;
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand the bench"
      title="Expand the bench"
      className="panel group flex w-10 shrink-0 flex-col items-center gap-4 border-r border-line py-4 transition-colors hover:bg-gilt/[0.05]"
    >
      <span className="font-mono text-[13px] leading-none text-mute transition-colors group-hover:text-gilt">»</span>
      <span className="eyebrow rotate-180 tracking-[0.3em] [writing-mode:vertical-rl]">The Bench</span>
      {total > 0 && (
        <span className="mt-auto font-mono text-[12px] tabular-nums text-mute">
          <span className="text-cream">{aliveCount}</span>/{total}
        </span>
      )}
    </button>
  );
}

/** The wagers panel collapsed to a sliver on the right — a vertical label plus a live-betting pulse,
 *  expanding the full Wagers panel back. Mirrors the bench rail on the opposite edge. */
function WagersRail({ s, onExpand }: { s: ViewState; onExpand: () => void }) {
  const live = s.market.state === "OPEN" && s.market.bettingLive === true;
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label="Expand the wagers"
      title={live ? "Wagers open — expand to bet" : "Expand the wagers"}
      className="panel group flex w-10 shrink-0 flex-col items-center gap-4 border-l border-line py-4 transition-colors hover:bg-gilt/[0.05]"
    >
      <span className="font-mono text-[13px] leading-none text-mute transition-colors group-hover:text-gilt">«</span>
      <span className="eyebrow tracking-[0.3em] [writing-mode:vertical-rl]">The Wagers</span>
      {live && (
        <span aria-hidden className="mt-auto h-1.5 w-1.5 animate-livepulse rounded-full bg-gilt" title="Wagers open" />
      )}
    </button>
  );
}

/** Masthead wallet pill — a "Connect wallet" call-to-action until connected, then the live CHIP
 *  balance. Sits left of the audio controls; the per-market action zones still own the actual betting. */
function WalletCapsule({ s, connect, className }: { s: ViewState; connect: () => void; className?: string }) {
  const connecting = s.wallet.status === "connecting";
  if (s.wallet.status === "connected") {
    const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
    return (
      <span
        title={s.wallet.account ?? undefined}
        className={[
          "flex h-9 items-center gap-2 rounded-full border border-line-2 bg-ink-2 px-3.5 font-mono text-[12px] tracking-[0.06em] text-cream",
          className ?? "",
        ].join(" ")}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-acquit shadow-[0_0_8px_rgba(127,160,126,0.8)]" />
        {balance != null ? `${balance.toFixed(3)} CHIP` : "wallet"}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={connect}
      disabled={connecting}
      className={[
        "flex h-9 items-center rounded-full border border-gilt/50 bg-ink-2 px-3.5 font-mono text-[12px] uppercase tracking-[0.14em] text-gilt transition-colors hover:border-gilt hover:bg-gilt/10 disabled:opacity-60",
        className ?? "",
      ].join(" ")}
    >
      {connecting ? "Connecting…" : "Connect wallet"}
    </button>
  );
}

/** Desktop header in the compact mobile-header style: a back arrow, the title + liveness chip with the
 *  phase (and current speaker) beneath, then the wallet + audio controls. Tapping the title block opens
 *  the record. The phase/liveness used to live on the Court stage; they ride here now. */
function DesktopHeader({
  s,
  music,
  sound,
  voice,
  connect,
  onOpenRecord,
}: {
  s: ViewState;
  music: ReturnType<typeof useMusic>;
  sound: ReturnType<typeof useSound>;
  voice: ReturnType<typeof useVoice>;
  connect: () => void;
  onOpenRecord: () => void;
}) {
  const live = liveness(s);
  const speaker =
    s.speakingSeat != null
      ? s.personas.find((p) => p.seat === s.speakingSeat)?.name ?? `Seat ${s.speakingSeat}`
      : null;
  return (
    <header className="flex shrink-0 items-center gap-4 border-b hairline pb-3 pt-3">
      <button
        type="button"
        onClick={() => navigate("menu")}
        aria-label="Back to lobby"
        title="Back to lobby"
        className="font-mono text-[24px] leading-none text-mute transition-colors hover:text-gilt"
      >
        ‹
      </button>

      <button type="button" onClick={onOpenRecord} title="Open the record" className="min-w-0 text-left">
        <div className="flex items-center gap-3">
          <span className="font-display text-[24px] font-semibold uppercase leading-none tracking-[0.3em] text-gilt">
            Turing Pits
          </span>
          <span className={["flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em]", live.cls].join(" ")}>
            <span className={["h-1.5 w-1.5 rounded-full", live.dot, live.pulse ? "animate-livepulse" : ""].join(" ")} />
            {live.label}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[11px] uppercase tracking-[0.18em] text-gilt">
          {phaseTag(s)}
          {speaker && <span className="text-cream"> · {speaker} speaking</span>}
        </div>
      </button>

      <div className="ml-auto flex items-center gap-3">
        {s.isMock && (
          <span className="rounded-sm border border-gilt-soft/40 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-gilt-soft" title="Replaying a captured match">
            ◈ Mock feed
          </span>
        )}
        <WalletCapsule s={s} connect={connect} />
        <AudioControls music={music} sound={sound} voice={voice} />
      </div>
    </header>
  );
}

/** One uniform circular audio control — the music note and the SFX speaker share this exact chrome. */
function AudioToggle({
  on,
  onToggle,
  label,
  children,
}: {
  on: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={on}
      className={[
        "flex h-9 w-9 items-center justify-center rounded-full border bg-ink-2 text-[15px] transition-colors hover:border-gilt hover:text-cream",
        on ? "border-gilt text-gilt" : "border-line-2 text-mute",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/** Monochrome speaker that inherits the button's colour (so it matches the ♪ glyph, not a colour emoji). */
function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M3 6h2.5L9 3.2v9.6L5.5 10H3z" fill="currentColor" />
      {on ? (
        <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M11.2 6.1a3 3 0 0 1 0 3.8" />
          <path d="M12.9 4.7a5.2 5.2 0 0 1 0 6.6" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
          <path d="M11.5 6.2 14.5 9.8" />
          <path d="M14.5 6.2 11.5 9.8" />
        </g>
      )}
    </svg>
  );
}

/** Voice-level bars for the character-voices toggle — a slash crosses them when muted. */
function VoiceWavesIcon({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      {on ? (
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M4 6.4v3.2" />
          <path d="M6.7 4.3v7.4" />
          <path d="M9.3 2.8v10.4" />
          <path d="M12 5.3v5.4" />
        </g>
      ) : (
        <g stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M4 7.2v1.6" />
          <path d="M6.7 6.5v3" />
          <path d="M9.3 6.9v2.2" />
          <path d="M12 7.2v1.6" />
          <path d="M2.6 2.6 13.4 13.4" opacity="0.75" />
        </g>
      )}
    </svg>
  );
}

/** The audio controls, grouped — placed in the top panel of both layouts so they never relocate.
 *  The character-voices toggle only appears when the server has TTS configured (`voice.available`). */
function AudioControls({
  music,
  sound,
  voice,
  className,
}: {
  music: ReturnType<typeof useMusic>;
  sound: ReturnType<typeof useSound>;
  voice: ReturnType<typeof useVoice>;
  className?: string;
}) {
  return (
    <div className={["flex items-center gap-2", className ?? ""].join(" ")}>
      <AudioToggle
        on={music.on}
        onToggle={music.toggle}
        label={music.on ? "Pause background music" : "Play background music"}
      >
        ♪
      </AudioToggle>
      <AudioToggle
        on={sound.on}
        onToggle={sound.toggle}
        label={sound.on ? "Mute sound effects" : "Unmute sound effects"}
      >
        <SpeakerIcon on={sound.on} />
      </AudioToggle>
      {voice.available && (
        <AudioToggle
          on={voice.on}
          onToggle={voice.toggle}
          label={voice.on ? "Mute character voices" : "Unmute character voices"}
        >
          <VoiceWavesIcon on={voice.on} />
        </AudioToggle>
      )}
    </div>
  );
}

// ── narrow-only pieces ───────────────────────────────────────────────────────────

/** Compact sticky header for the stage layout — the case identity, liveness, and the two drawers. */
function MobileHeader({
  s,
  music,
  sound,
  voice,
  onOpenBench,
  onOpenRecord,
}: {
  s: ViewState;
  music: ReturnType<typeof useMusic>;
  sound: ReturnType<typeof useSound>;
  voice: ReturnType<typeof useVoice>;
  onOpenBench: () => void;
  onOpenRecord: () => void;
}) {
  const live = liveness(s);
  // Mid-match the bench is a drawer, so on a phone you can't see who still stands or who holds the
  // floor without opening it. Surface both in the header: a compact alive count, and the speaker.
  const aliveCount = s.seats.filter((x) => x.alive).length;
  const total = s.seats.length;
  const speaker =
    s.speakingSeat != null
      ? s.personas.find((p) => p.seat === s.speakingSeat)?.name ?? `Seat ${s.speakingSeat}`
      : null;
  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b hairline px-4 py-2.5">
      <button
        type="button"
        onClick={() => navigate("menu")}
        aria-label="Back to lobby"
        className="font-mono text-[20px] leading-none text-mute transition-colors hover:text-gilt"
      >
        ‹
      </button>

      <button type="button" onClick={onOpenRecord} title="Open the record" className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[17px] font-semibold uppercase tracking-[0.2em] text-cream">
            Turing Pits
          </span>
          <span className={["flex shrink-0 items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.14em]", live.cls].join(" ")}>
            <span className={["h-1.5 w-1.5 rounded-full", live.dot, live.pulse ? "animate-livepulse" : ""].join(" ")} />
            {live.label}
          </span>
        </div>
        <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-gilt">
          {phaseTag(s)}
          {speaker && <span className="text-cream"> · {speaker} speaking</span>}
        </div>
      </button>

      <AudioControls music={music} sound={sound} voice={voice} />

      <button
        type="button"
        onClick={onOpenBench}
        aria-label={total > 0 ? `Open the bench · ${aliveCount} of ${total} still stand` : "Open the bench"}
        title={total > 0 ? `${aliveCount} of ${total} still stand` : "Open the bench"}
        className="flex h-9 items-center gap-1.5 rounded-full border border-line-2 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:border-gilt hover:text-gilt"
      >
        <span className="text-[14px] leading-none">☰</span>
        {total > 0 ? (
          <span className="tabular-nums tracking-normal">
            <span className="text-cream">{aliveCount}</span>/{total}
          </span>
        ) : (
          "Bench"
        )}
      </button>
    </header>
  );
}

/** The persistent wager dock — reads the live market state, surfaces the countdown, opens the sheet. */
function BottomDock({ s, onOpen }: { s: ViewState; onOpen: () => void }) {
  const live = s.market.state === "OPEN" && s.market.bettingLive === true;
  // An in-loop window (its own countdown) takes precedence over the ever-open faction countdown.
  const windowCountdown = useCountdown(s.betWindow?.endsAt ?? null);
  const factionCountdown = useCountdown(live && !s.betWindow ? s.market.closesAt : null);
  const countdown = s.betWindow ? windowCountdown : factionCountdown;
  const closingSoon = countdown != null && countdown.ms <= (s.betWindow ? 10000 : 15000);
  // Every market (the faction headline included) is a prop, so one scan over propStakes covers them all.
  const hasWager = s.propStakes.some((ps) => ps.stakes.some((v) => parseFloat(v) > 0));

  // Status line + call-to-action, mapped from the real market lifecycle. The CTA always raises the
  // full Wagers sheet — the dock surfaces *state*, the sheet holds the actions.
  let label: string;
  let cta: string;
  let tone: "live" | "soft" | "mute" | "claim";
  if (s.betWindow) {
    label =
      s.betWindow.market === "NIGHT_KILL"
        ? "Betting window · who dies tonight?"
        : s.betWindow.market === "ROUND_VOTED_OUT"
          ? "Betting window · who hangs?"
          : "Betting window · real or bluff?";
    cta = "Bet now";
    tone = "live";
  } else if (live) {
    label = "Wagers open · bet now";
    cta = "Wager";
    tone = "live";
  } else if (s.market.state === "OPEN") {
    label = "Sealing the record…";
    cta = "Wagers";
    tone = "soft";
  } else if (s.market.state === "LOCKED") {
    label = "Wagers sealed · match running";
    cta = "View";
    tone = "mute";
  } else if (s.market.state === "REFUND") {
    label = "Match abandoned · refundable";
    cta = "Reclaim";
    tone = "claim";
  } else {
    const factionVoid = (s.market.props ?? []).find((p) => p.kind === "FACTION")?.state === "VOID";
    label = factionVoid ? "Stakes returned" : "Verdict settled on-chain";
    cta = "Results";
    tone = "claim";
  }

  const labelCls = tone === "live" ? "text-gilt" : tone === "claim" ? "text-acquit" : "text-cream-dim";
  const ctaCls =
    tone === "live"
      ? "border-gilt text-gilt"
      : tone === "claim"
        ? "border-acquit text-acquit"
        : "border-line-2 text-cream-dim";

  return (
    <div className="shrink-0 border-t border-line-2 bg-ink-2/95 backdrop-blur">
      <button type="button" onClick={onOpen} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow">The Wagers</span>
            {hasWager && (
              <span className="text-[10px] text-gilt" title="You hold a wager">
                ●
              </span>
            )}
          </div>
          <div className={["mt-0.5 truncate font-mono text-[12px] uppercase tracking-[0.12em]", labelCls].join(" ")}>
            {label}
          </div>
        </div>

        {countdown && (
          <span
            className={[
              "shrink-0 font-mono text-[18px] tabular-nums tracking-[0.06em]",
              closingSoon ? "animate-livepulse text-convict" : "text-gilt",
            ].join(" ")}
          >
            {countdown.label}
          </span>
        )}

        <span
          className={[
            "shrink-0 rounded-sm border px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em]",
            ctaCls,
          ].join(" ")}
        >
          {cta} ›
        </span>
      </button>
    </div>
  );
}

/** The bench, slid in from the left. The Bench panel renders its own header + scroll. */
function BenchDrawer({ s, onClose }: { s: ViewState; onClose: () => void }) {
  const dialogRef = useDialog<HTMLElement>(onClose);
  return (
    <>
      <motion.div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="The bench"
        className="panel fixed inset-y-0 left-0 z-50 flex w-[min(86vw,340px)] flex-col border-r border-line-2"
        initial={{ x: "-100%" }}
        animate={{ x: 0 }}
        exit={{ x: "-100%" }}
        transition={{ type: "tween", duration: 0.25 }}
      >
        <button
          type="button"
          aria-label="Close the bench"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 font-mono text-[20px] leading-none text-mute transition-colors hover:text-cream"
        >
          ✕
        </button>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <Bench s={s} />
        </div>
      </motion.aside>
    </>
  );
}

/** The full Wagers panel, raised from the bottom as a sheet. */
function WagersSheet({ api, onClose }: { api: MatchApi; onClose: () => void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  return (
    <>
      <motion.div
        className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Wagers"
        className="panel fixed inset-x-0 bottom-0 z-50 flex h-[86dvh] flex-col rounded-t-2xl border-t border-line-2"
        initial={{ y: "100%" }}
        animate={{ y: 0 }}
        exit={{ y: "100%" }}
        transition={{ type: "tween", duration: 0.28 }}
      >
        <div className="flex shrink-0 justify-center pt-3 pb-1">
          <span aria-hidden className="h-1 w-10 rounded-full bg-line-2" />
        </div>
        <button
          type="button"
          aria-label="Close wagers"
          onClick={onClose}
          className="absolute right-4 top-3 z-10 font-mono text-[20px] leading-none text-mute transition-colors hover:text-cream"
        >
          ✕
        </button>
        <div className="min-h-0 flex-1">
          <Verdict api={api} />
        </div>
      </motion.div>
    </>
  );
}
