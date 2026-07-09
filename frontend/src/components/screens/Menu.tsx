import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MatchApi } from "../../state/matchStore.js";
import { fetchDisplayNames, type MatchStatus } from "../../lib/contract.js";
import { getLocalName, pseudonymFor, validHandle, MAX_HANDLE_LEN } from "../../lib/names.js";
import { useLiveStatus } from "../../lib/useLiveStatus.js";
import { navigate } from "../../lib/useRoute.js";
import { startTour } from "../tour/Onboarding.js";

/**
 * The lobby. The arena, the history, and the wallet were all crammed onto one screen before — this
 * is the calm entry point that routes to each. Connecting a wallet here carries through to the other
 * screens (the match store is mounted once, app-wide).
 *
 * The live WS feed only runs on the Live screen (and opening it would start a match), so the lobby
 * learns "is court in session, what round, how big the pot" from the server's read-only `/status`
 * poll instead — see useLiveStatus. There is no betting-close countdown: betting stays open until
 * settlement by design (server/src/orchestrator.ts), so the chip says "wagers open", not a timer.
 *
 * Visually the lobby is framed like a playbill: an ornate double-line frame with corner brackets, the
 * mask crest straddling the top break, ambient motif icons down each side, and chamfered cards whose
 * medallions overhang the top edge. The frame wraps the content (it is a sibling that grows with it),
 * so the whole crest-and-frame unit stays centred and responsive across viewports.
 */
export function Menu({ api }: { api: MatchApi }) {
  const s = api.state;
  const connected = s.wallet.status === "connected";
  const balance = s.wallet.balance != null ? parseFloat(s.wallet.balance) : null;
  // Gas relayer status. Session / guest wallets hold no 0G, so they bet ONLY through the relayer —
  // these two flags decide whether pop-up-free wagering is available or paused (offline / out of gas).
  const relayLive = !!s.relay?.enabled;
  const relayFunded = !!s.relay?.funded;
  const status = useLiveStatus();

  return (
    <main className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-clip px-4 py-[clamp(2rem,5vh,3.5rem)] sm:px-6">
      <div className="relative w-full max-w-[1180px]">
        <OuterFrame />
        {/* Ambient motifs anchored to the frame, just outside its left/right edges, near the top. */}
        <SideMotifs side="left" />
        <SideMotifs side="right" />
        <TopCrest />

        <div className="relative flex flex-col items-center px-[clamp(1.25rem,5vw,4rem)] pb-[clamp(1.5rem,4vh,2.75rem)] pt-[clamp(4.5rem,10vh,6.5rem)] text-center">
          <div className="eyebrow mb-[clamp(0.5rem,1.5vh,0.9rem)]">The People v/s The Hidden Hand</div>
          {/* The wide tracking blows past narrow viewports; ease it (and the min size) on phones so
              the wordmark never overflows or clips. A cream→gilt gradient gives it the struck-metal look. */}
          <h1 className="bg-gradient-to-b from-cream via-cream to-gilt-soft bg-clip-text font-display text-[clamp(2rem,3.5vw,4.25rem)] font-semibold uppercase leading-none tracking-[0.16em] text-transparent sm:tracking-[0.34em]">
            Turing Pits
          </h1>
          <div className="mt-[clamp(0.75rem,2vh,1.25rem)] font-body text-[clamp(1rem,1.8vw,1.1875rem)] italic text-gilt-soft">
            AI agents play Mafia. You predict the verdict.
          </div>

          <button
            type="button"
            onClick={() => startTour()}
            className="mt-[clamp(0.5rem,1.5vh,0.9rem)] inline-flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.2em] text-mute underline decoration-line-2 underline-offset-4 transition-colors hover:text-gilt"
          >
            New here? Take the guided tour
          </button>

          <div className="mt-[clamp(1.75rem,5vh,3rem)] grid w-full grid-cols-1 gap-[clamp(1rem,2.5vw,1.75rem)] sm:grid-cols-2">
            <MenuCard
              title="Enter the Court"
              blurb="Watch a live match unfold and make predictions."
              cta="Watch live ›"
              onClick={() => navigate("live")}
              icon={<PlayIcon />}
              status={status?.live ? <LiveChip status={status} /> : undefined}
            />
            <MenuCard
              title="Battle History"
              blurb="Every past battle, its verdicts, and winnings."
              cta="Open history ›"
              onClick={() => navigate("history")}
              icon={<ChartIcon />}
            />
          </div>

          {/* A small filigree diamond between the cards and the wallet, echoing the frame's ornaments. */}
          <div className="my-[clamp(1rem,2.5vh,1.5rem)] flex items-center gap-3 text-gilt/40">
            <span className="h-px w-10 bg-gradient-to-l from-gilt/40 to-transparent" />
            <span className="h-1.5 w-1.5 rotate-45 border border-gilt/50" />
            <span className="h-px w-10 bg-gradient-to-r from-gilt/40 to-transparent" />
          </div>

          <WalletCard
            api={api}
            connected={connected}
            balance={balance}
            relayLive={relayLive}
            relayFunded={relayFunded}
          />
        </div>
      </div>

      {(s.wallet.error || s.tx.error) && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-6">
          <div className="pointer-events-auto max-w-[440px] rounded-sm border border-convict/50 bg-ink-2/95 px-4 py-2 text-center font-mono text-[11px] text-convict shadow-lg">
            {s.wallet.error ?? s.tx.error}
          </div>
        </div>
      )}
    </main>
  );
}

/**
 * The ornate playbill frame: a double gilt hairline with rounded corners, four corner brackets, and a
 * break at top-centre where the crest sits. Purely decorative — pointer-events off so it never eats a
 * click meant for a card underneath it.
 */
function OuterFrame() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 rounded-[clamp(20px,3vw,34px)] border border-gilt/25" />
      <div className="absolute inset-[6px] rounded-[clamp(16px,2.6vw,28px)] border border-gilt/10" />
      {/* Corner brackets. */}
      <span className="absolute left-3 top-3 h-5 w-5 rounded-tl-[10px] border-l border-t border-gilt/45" />
      <span className="absolute right-3 top-3 h-5 w-5 rounded-tr-[10px] border-r border-t border-gilt/45" />
      <span className="absolute bottom-3 left-3 h-5 w-5 rounded-bl-[10px] border-b border-l border-gilt/45" />
      <span className="absolute bottom-3 right-3 h-5 w-5 rounded-br-[10px] border-b border-r border-gilt/45" />
    </div>
  );
}

/**
 * The mask crest, straddling the top break of the frame. The circle's own opaque backing masks the
 * frame line behind it; the flourish lines (bright near the crest, fading out to a diamond node) sit
 * on top of the frame's top edge, so the "break" reads as intentional rather than a gap.
 */
function TopCrest() {
  return (
    <div className="absolute left-1/2 top-0 z-10 flex -translate-x-1/2 -translate-y-[30%] items-center gap-[clamp(0.75rem,2vw,1.25rem)]">
      <Flourish dir="left" />
      <img
        src="/Logo.png"
        alt="Turing Pits crest"
        className="h-[clamp(96px,13vw,128px)] w-[clamp(96px,13vw,128px)] shrink-0 object-contain [filter:drop-shadow(0_0_26px_rgba(201,162,63,0.3))]"
      />
      <Flourish dir="right" />
    </div>
  );
}

function Flourish({ dir }: { dir: "left" | "right" }) {
  const diamond = <span className="h-1.5 w-1.5 shrink-0 rotate-45 border border-gilt/60" />;
  const line = (
    <span
      className={`h-px w-[clamp(28px,7vw,96px)] ${
        dir === "left" ? "bg-gradient-to-l from-gilt/60 to-transparent" : "bg-gradient-to-r from-gilt/60 to-transparent"
      }`}
    />
  );
  return (
    <span className="hidden items-center gap-2 sm:flex">
      {dir === "left" ? (
        <>
          {diamond}
          {line}
        </>
      ) : (
        <>
          {line}
          {diamond}
        </>
      )}
    </span>
  );
}

/** Ambient theatre-of-the-market motifs down each frame edge — the mafia + prediction-market vocabulary
 *  (fedora, domino mask, voice waveform, candlesticks). Decorative; hidden where the frame gets tight. */
function SideMotifs({ side }: { side: "left" | "right" }) {
  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute top-[clamp(1.5rem,5vh,3.5rem)] hidden flex-col items-center gap-[clamp(1.25rem,4vh,2.25rem)] text-gilt/35 lg:flex ${
        side === "left" ? "right-full mr-[clamp(0.75rem,1.8vw,2rem)]" : "left-full ml-[clamp(0.75rem,1.8vw,2rem)]"
      }`}
    >
      <HatIcon />
      <MaskIcon />
      <WaveIcon />
      <CandleIcon />
    </div>
  );
}

/**
 * The pull-through cue on the primary card: tells you whether court is in session before you click
 * in. Live → a pulsing dot + round + pot + "predictions open"; idle → nothing (the card CTA already
 * invites you in, and entering begins the next trial).
 */
function LiveChip({ status }: { status: MatchStatus | null }) {
  if (!status || !status.live) {
    return null;
  }
  const pot = parseFloat(status.pot);
  const potLabel = pot > 0 && pot < 10 ? pot.toFixed(1) : Math.round(pot).toString();
  const round = status.round > 0 ? `round ${status.round}` : "opening";
  const tail = status.bettingLive ? `◈${potLabel} pot · predictions open` : "predictions open soon";
  return (
    <span className="flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-convict animate-livepulse" />
      In session · {round} · {tail}
    </span>
  );
}

/**
 * A chamfered lobby card with a medallion badge overhanging its top edge. The medallion is a sibling
 * of the clipped panel (clip-path would otherwise clip its overhang) and is decorative — the whole
 * panel is the button.
 */
function MenuCard(p: {
  title: string;
  blurb: string;
  cta: string;
  onClick: () => void;
  icon: ReactNode;
  status?: ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={p.onClick}
        className="oct group block w-full bg-gradient-to-b from-gilt/55 via-gilt/20 to-gilt/10 p-px text-center transition-transform duration-200 hover:-translate-y-0.5"
      >
        <span className="oct flex h-full flex-col items-center bg-ink-2 px-[clamp(1rem,2.5vw,1.6rem)] pb-[clamp(1.1rem,3vh,1.5rem)] pt-[clamp(2.35rem,4.5vh,2.75rem)] transition-colors group-hover:bg-ink-3">
          <span className="font-display text-[clamp(1.25rem,2.6vw,1.6rem)] uppercase tracking-[0.08em] text-cream">
            {p.title}
          </span>
          <span className="mt-2 max-w-[26ch] font-body text-[clamp(0.875rem,1.35vw,0.975rem)] leading-snug text-cream-dim">
            {p.blurb}
          </span>
          {p.status && <span className="mt-3 block">{p.status}</span>}
          <span className="mt-[clamp(0.8rem,2vh,1.15rem)] font-mono text-[11.5px] uppercase tracking-[0.2em] text-gilt transition-transform group-hover:translate-x-0.5">
            {p.cta}
          </span>
        </span>
      </button>
      {/* Medallion — overhangs the top edge, so it lives OUTSIDE the clipped panel. */}
      <span className="pointer-events-none absolute -top-6 left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-ink-2 text-gilt shadow-[0_0_24px_rgba(201,162,63,0.3)] ring-1 ring-gilt/70">
        <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-gilt/30" />
        {p.icon}
      </span>
    </div>
  );
}

/**
 * The wallet as a chamfered bar. Disconnected: one clear CTA + why. Connected: a gem medallion, the
 * address + chain, balance, the faucet, and the shared-handle editor. Session / guest wallets always
 * bet through the relayer (they hold no 0G), so there is no gas toggle here.
 */
function WalletCard(p: {
  api: MatchApi;
  connected: boolean;
  balance: number | null;
  relayLive: boolean;
  relayFunded: boolean;
}) {
  const { api, connected, balance } = p;
  const s = api.state;

  const connecting = s.wallet.status === "connecting";

  if (!connected) {
    return (
      <div className="oct mx-auto w-full max-w-[460px] bg-gradient-to-b from-gilt/45 via-gilt/15 to-gilt/10 p-px">
        <div className="oct bg-ink-2 px-6 py-[clamp(1.5rem,4vh,1.9rem)] text-center">
          <div className="font-display text-[16px] uppercase tracking-[0.06em] text-cream">Connect to predict</div>
          <button
            type="button"
            onClick={() => void api.connect()}
            disabled={connecting}
            className="mt-5 w-full max-w-[300px] rounded-sm border border-gilt px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.18em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
          >
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
          <button
            type="button"
            onClick={() => void api.connectBurner()}
            disabled={connecting}
            className="mt-3 block w-full font-mono text-[11px] uppercase tracking-[0.14em] text-mute underline decoration-line-2 underline-offset-4 transition-colors hover:text-gilt disabled:opacity-60"
          >
            No wallet? Play as guest ›
          </button>
        </div>
      </div>
    );
  }

  const isGuest = s.wallet.mode === "guest";

  return (
    <div className="oct mx-auto w-full max-w-[620px] bg-gradient-to-b from-gilt/45 via-gilt/15 to-gilt/10 p-px">
      <div className="oct bg-ink-2 px-[clamp(1.25rem,3vw,1.75rem)] py-[clamp(1.25rem,3vh,1.5rem)] text-left">
        <div className="flex items-stretch gap-[clamp(1rem,3vw,1.75rem)]">
          <span className="relative flex h-16 w-16 shrink-0 self-center items-center justify-center rounded-full bg-ink text-gilt shadow-[0_0_24px_rgba(201,162,63,0.22)] ring-1 ring-gilt/60">
            <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-gilt/25" />
            <GemIcon />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-3">
              <span className="eyebrow">{isGuest ? "Guest wallet" : "Session wallet"}</span>
              <span className="truncate font-mono text-[11px] tracking-[0.1em] text-mute">
                {s.wallet.account?.slice(0, 6)}…{s.wallet.account?.slice(-4)} · 0G Galileo
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <span className="font-mono text-[clamp(1.35rem,3vw,1.65rem)] tabular-nums tracking-[0.02em] text-cream">
                {balance != null ? balance.toFixed(2) : "…"}
                <span className="ml-1.5 text-[12px] tracking-[0.12em] text-mute">CHIP</span>
              </span>
              <button
                type="button"
                onClick={() => void api.getTestTokens()}
                disabled={s.tx.pending}
                className="shrink-0 rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim transition-colors hover:border-gilt hover:text-gilt disabled:opacity-60"
              >
                {s.tx.pending ? "Minting…" : "Get test CHIP"}
              </button>
            </div>

            {s.wallet.account && <NameEditor api={api} account={s.wallet.account} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Inline motif + medallion icons ──────────────────────────────────────────────────────────── */

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden>
      <rect x="4" y="13" width="3.4" height="7" rx="0.6" />
      <rect x="10.3" y="9" width="3.4" height="11" rx="0.6" />
      <rect x="16.6" y="5" width="3.4" height="15" rx="0.6" />
    </svg>
  );
}

function GemIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M12 3l9 9-9 9-9-9z" />
      <path d="M12 7.5l4.5 4.5-4.5 4.5-4.5-4.5z" />
    </svg>
  );
}

function HatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden>
      <path d="M7 13c0-5 1.2-8 5-8s5 3 5 8" />
      <path d="M3.5 14.5c1.5 1.2 4.6 2 8.5 2s7-0.8 8.5-2" />
      <path d="M7 12.8c1.4 0.7 3 1 5 1s3.6-0.3 5-1" />
    </svg>
  );
}

function MaskIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M3.5 7.5c3-1 5.5-1 8.5-1s5.5 0 8.5 1c0.4 4.2-1.2 8-4.7 8-2 0-2.8-1.6-3.8-1.6s-1.8 1.6-3.8 1.6C4.7 15.5 3.1 11.7 3.5 7.5z" />
      <path d="M6.5 9.2c1.2-0.7 2.6-0.7 3.6 0.2" />
      <path d="M17.5 9.2c-1.2-0.7-2.6-0.7-3.6 0.2" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d="M3 12h1M6.5 8.5v7M10 5v14M13.5 8v8M17 6v12M20.5 10v4" />
    </svg>
  );
}

function CandleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M6 4v4M6 14v3" />
      <rect x="4.4" y="8" width="3.2" height="6" rx="0.4" />
      <path d="M13 6v3M13 15v3" />
      <rect x="11.4" y="9" width="3.2" height="6" rx="0.4" />
      <path d="M19 3v3M19 12v3" />
      <rect x="17.4" y="6" width="3.2" height="6" rx="0.4" />
    </svg>
  );
}

/**
 * The lobby handle editor. Everyone gets a deterministic pseudonym for free (shown as the default); a
 * player can claim a custom handle here that's shared so it shows on OTHER viewers' match leaderboards.
 * The name is signed locally by the session key (no pop-up) and verified server-side. Prefills from the
 * shared handle (so it's consistent across devices), falling back to the local cache then the pseudonym.
 */
function NameEditor({ api, account }: { api: MatchApi; account: string }) {
  const [serverName, setServerName] = useState<string | null>(() => getLocalName(account));
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pull the authoritative shared handle (if any) so the lobby shows what others see, not just a stale
  // local cache. Best-effort — a failure just leaves the local/pseudonym default.
  useEffect(() => {
    let alive = true;
    void fetchDisplayNames([account]).then((names) => {
      const n = names[account.toLowerCase()];
      if (alive && n) setServerName(n);
    });
    return () => {
      alive = false;
    };
  }, [account]);

  const current = serverName ?? getLocalName(account);
  const display = current ?? pseudonymFor(account);

  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the field when entering edit mode (autoFocus only fires on mount; the field stays mounted here).
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const start = () => {
    setValue(current ?? "");
    setError(null);
    setEditing(true);
  };
  const cancel = () => {
    setEditing(false);
    setError(null);
  };
  const save = async () => {
    const name = value.trim();
    if (!validHandle(name)) {
      setError(`Use 1–${MAX_HANDLE_LEN} characters — no line breaks.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.setDisplayName(name);
      setServerName(name);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save your handle.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 border-t border-line pt-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-[11rem] flex-1 flex-wrap items-center gap-x-3 gap-y-1">
          <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim">Your handle:</span>
          {editing ? (
            <input
              ref={inputRef}
              value={value}
              maxLength={MAX_HANDLE_LEN}
              placeholder={pseudonymFor(account)}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") cancel();
              }}
              // Clicking anywhere off the field (except Save, which suppresses the blur below) cancels the edit.
              onBlur={() => {
                if (!saving) cancel();
              }}
              className="min-w-0 flex-1 basis-[9rem] border border-line bg-ink px-2.5 py-1.5 font-body text-[15px] text-cream outline-none transition-colors focus:border-gilt"
            />
          ) : (
            <span className="min-w-0 flex-1 basis-[9rem] truncate font-display text-[18px] font-semibold tracking-[0.02em] text-cream">
              {display}
            </span>
          )}
        </div>
        <button
          type="button"
          // Suppress the mousedown-driven blur so saving isn't cancelled before the click lands.
          onMouseDown={(e) => editing && e.preventDefault()}
          onClick={editing ? () => void save() : start}
          disabled={saving}
          className="shrink-0 rounded-sm border border-gilt px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt transition-colors hover:bg-gilt hover:text-ink disabled:opacity-60"
        >
          {editing ? (saving ? "Saving…" : "Save") : "Edit"}
        </button>
      </div>
      {error && <p className="mt-2 font-mono text-[11px] text-convict">{error}</p>}
    </div>
  );
}
