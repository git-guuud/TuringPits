import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { navigate } from "../../lib/useRoute.js";
import { useMediaQuery } from "../../lib/useMediaQuery.js";

/**
 * The Usher's Walk — a scripted, first-run guided tour for newcomers.
 *
 * The Tribunal layers a courtroom over an already-unfamiliar game (Mafia) and a three-way wager; a
 * cold-open into a live match is a lot to parse. This tour hands a first-timer a court usher who walks
 * them through the room in about a minute: connect a wallet, mint test CHIP, enter the court, then the
 * bench / court / wagers panels and how a bet is placed.
 *
 * It is entirely SELF-CONTAINED and scripted — it renders its own faithful MOCK of the lobby and the
 * courtroom (never the real one) so it touches no wallet, opens no WebSocket, and starts no match. The
 * signature is the "usher's lantern": a gilt spotlight (echoing the Court's banker's lamp) that sweeps
 * across a darkened mock courtroom, dimming everything but the region in focus, with an inked arrow.
 */

const SEEN_KEY = "turingpits.tour.v1.seen";
const TOUR_EVENT = "turingpits:tour";

/** Open the tour from anywhere (HowItWorks, the lobby). Decoupled via a window event. */
export function startTour() {
  window.dispatchEvent(new Event(TOUR_EVENT));
}

// ── The script ────────────────────────────────────────────────────────────────────
type Chapter = "welcome" | "lobby" | "court" | "history" | "done";
type Target = "connect" | "faucet" | "enter" | "bench" | "court" | "wagers" | "bet" | "tray" | "back" | "historyCard" | "record" | null;

interface Step {
  chapter: Chapter;
  target: Target;
  eyebrow: string;
  title: string;
  body: ReactNode;
  primary: string;
}

const STEPS: Step[] = [
  {
    chapter: "welcome",
    target: null,
    eyebrow: "The Usher",
    title: "Welcome to Turing Pits",
    body: (
      <>
        Six AI agents play Mafia, a social deduction game where players try to find a secret killer. Your part is
        simple: <span className="text-cream">make predictions</span>.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "lobby",
    target: "connect",
    eyebrow: "The Lobby",
    title: "Sign in, just once",
    body: (
      <>
        Connect a wallet, or play as a guest if you don't have one.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "lobby",
    target: "faucet",
    eyebrow: "The Lobby",
    title: "Stock up on CHIP",
    body: (
      <>
        Tap <span className="text-gilt">Get test CHIP</span>.
        It’s play money - spend it freely.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "lobby",
    target: "enter",
    eyebrow: "The Lobby",
    title: "Enter the court",
    body: (
      <>
        This is where a live match plays out turn by turn.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "court",
    target: "bench",
    eyebrow: "The Courtroom",
    title: "The Bench",
    body: (
      <>
        Every agent takes a seat. See who is still alive, who’s drawing votes and, in the end,
        the roles are revealed.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "court",
    target: "court",
    eyebrow: "The Courtroom",
    title: "The Court",
    body: (
      <>
        Centre stage is the drama: dialogues, kills, votes. All appear here.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "court",
    target: "wagers",
    eyebrow: "The Courtroom",
    title: "The Predictions",
    body: (
      <>
        Every market lives here. Make predictions, see the odds shift as the crowd predicts.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "court",
    target: "bet",
    eyebrow: "The Courtroom",
    title: "Place a prediction",
    body: (
      <>
        Pick an outcome, set your amount, confirm. That’s the whole move.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "court",
    target: "back",
    eyebrow: "The Courtroom",
    title: "Back to the lobby",
    body: (
      <>
        The back arrow, takes you back to the lobby the match keeps running.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "lobby",
    target: "historyCard",
    eyebrow: "The Lobby",
    title: "Your record",
    body: (
      <>
        Every battle is recorded in <span className="text-cream">Battle History</span>.
        Open it to see results of any past match.
      </>
    ),
    primary: "Next",
  },
  {
    chapter: "done",
    target: null,
    eyebrow: "The Usher",
    title: "You’re sworn in",
    body: (
      <>
        That’s the whole room. The <span className="text-gilt">?</span> in the corner holds the full rules
        any time you want them. I’ll leave you at the lobby — enter the court whenever you’re ready.
      </>
    ),
    primary: "Done!",
  },
];

const idxOf = (t: Target) => STEPS.findIndex((s) => s.target === t);
const CONNECT_I = idxOf("connect");
const FAUCET_I = idxOf("faucet");
const BET_I = idxOf("bet");

// ── geometry ────────────────────────────────────────────────────────────────────
interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
type Side = "top" | "bottom" | "left" | "right" | "center";
interface Geom {
  hole: Box | null;
  card: { left: number; top: number };
  side: Side;
}

const PAD = 10;
const GAP = 22;
const MARGIN = 16;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

export function Onboarding() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  const step = STEPS[i]!;
  const reduce = useReducedMotion();
  const wide = useMediaQuery("(min-width: 900px)");

  const targets = useRef<Map<Target, HTMLElement>>(new Map());
  const cardRef = useRef<HTMLDivElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [geom, setGeom] = useState<Geom | null>(null);

  const register = useCallback(
    (id: Target) => (el: HTMLElement | null) => {
      if (el) targets.current.set(id, el);
      else targets.current.delete(id);
    },
    [],
  );

  // First-run auto-open (once per browser), plus the on-demand event from the "?" / lobby.
  useEffect(() => {
    const launch = () => {
      setI(0);
      setOpen(true);
    };
    window.addEventListener(TOUR_EVENT, launch);
    let t: number | undefined;
    try {
      if (!localStorage.getItem(SEEN_KEY)) t = window.setTimeout(launch, 450);
    } catch {
      /* private mode — just don't auto-open */
    }
    return () => {
      window.removeEventListener(TOUR_EVENT, launch);
      if (t) clearTimeout(t);
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  const go = useCallback((dir: number) => {
    setI((cur) => clamp(cur + dir, 0, STEPS.length - 1));
  }, []);

  const finish = useCallback(() => {
    close();
    navigate("menu");
  }, [close]);

  // Lock the page behind the tour so nothing scrolls underneath the lantern.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Keyboard: ← / → step, Esc skips. Enter falls through to the focused button.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      } else if (e.key === "ArrowRight") {
        if (i < STEPS.length - 1) go(1);
      } else if (e.key === "ArrowLeft") {
        if (i > 0) go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, i, go, close]);

  // Move focus onto the step's primary action so the tour is fully keyboard-drivable.
  useEffect(() => {
    if (open) nextRef.current?.focus();
  }, [open, i]);

  // Measure the spotlight target + place the coach card in the roomiest adjacent gap. Re-runs on step
  // change and resize; a rAF pass catches any late layout settle (fonts, the scene's fade-in).
  useLayoutEffect(() => {
    if (!open) return;
    const compute = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const card = cardRef.current;
      const cw = card?.offsetWidth ?? 340;
      const ch = card?.offsetHeight ?? 200;

      const el = step.target ? targets.current.get(step.target) : null;
      if (!el) {
        setGeom({
          hole: null,
          side: "center",
          card: { left: clamp((vw - cw) / 2, MARGIN, vw - cw - MARGIN), top: clamp((vh - ch) / 2, MARGIN, vh - ch - MARGIN) },
        });
        return;
      }
      // The mock stage is a faithful full-size copy of the real screen, so on a phone the lobby is taller
      // than the viewport and a target (the wallet card, a lobby card) can sit below the fold — the whole
      // reason the tour looked broken on mobile. Bring the step's target into view inside the scrollable
      // stage before measuring, so the spotlight always lands on something visible. A no-op when it already
      // fits (desktop, the court panes), and instant so the rect we read next is the settled position.
      el.scrollIntoView({ block: "center", inline: "nearest" });
      const b = el.getBoundingClientRect();
      const hole: Box = { left: b.left - PAD, top: b.top - PAD, width: b.width + 2 * PAD, height: b.height + 2 * PAD };
      const cx = hole.left + hole.width / 2;
      const cy = hole.top + hole.height / 2;
      const below = vh - (hole.top + hole.height);
      const above = hole.top;
      const right = vw - (hole.left + hole.width);
      const left = hole.left;

      let side: Side;
      if (below >= ch + GAP + MARGIN) side = "bottom";
      else if (above >= ch + GAP + MARGIN) side = "top";
      else if (right >= cw + GAP + MARGIN) side = "right";
      else if (left >= cw + GAP + MARGIN) side = "left";
      else side = "bottom";

      let cardLeft = 0;
      let cardTop = 0;

      if (side === "bottom" || side === "top") {
        cardLeft = clamp(cx - cw / 2, MARGIN, vw - cw - MARGIN);
        const fits = side === "bottom" ? below >= ch + GAP + MARGIN : above >= ch + GAP + MARGIN;
        cardTop = side === "bottom" ? hole.top + hole.height + GAP : hole.top - GAP - ch;
        if (!fits) cardTop = clamp(vh - ch - MARGIN, MARGIN, vh - ch - MARGIN); // overlay fallback
      } else {
        cardTop = clamp(cy - ch / 2, MARGIN, vh - ch - MARGIN);
        cardLeft = side === "right" ? hole.left + hole.width + GAP : hole.left - GAP - cw;
      }

      setGeom({ hole, side, card: { left: cardLeft, top: cardTop } });
    };

    compute();
    const raf = requestAnimationFrame(compute);
    window.addEventListener("resize", compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", compute);
    };
  }, [open, i, step.target, wide]);

  if (!open) return null;

  const spring = reduce ? { duration: 0 } : { type: "spring" as const, stiffness: 280, damping: 32, mass: 0.9 };
  const total = STEPS.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Guided tour of the Tribunal"
      className="fixed inset-0 z-[70] overflow-hidden"
      style={{
        // Fully opaque so the tour cleanly REPLACES the view with its own mock — otherwise the real UI
        // behind bleeds through the gaps between panels (glitchy when launched over the lobby / a match).
        // Mirrors the app's own body backdrop so the tour reads as native.
        background:
          "radial-gradient(1200px 700px at 50% -8%, rgba(201,162,63,.06), transparent 60%), #0c0b08",
      }}
    >
      {/* The mock stage sits at full brightness; the lantern overlay (below) dims all but the focus. It
          scrolls when the faithful full-size mock is taller than the viewport (the lobby on a phone) — the
          compute pass scrolls each step's target into view here. Scrollbar hidden so it reads as a screen. */}
      <div
        aria-hidden
        className="absolute inset-0 z-0 overflow-y-auto overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {step.chapter === "lobby" && <MockLobby register={register} step={i} />}
        {step.chapter === "court" && <MockCourt register={register} step={i} wide={wide} />}
        {step.chapter === "history" && <MockHistory register={register} />}
      </div>

      {/* The lantern: a spotlight hole that dims everything else. A centered step has no hole → a flat veil. */}
      {geom &&
        (geom.hole ? (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute z-10 rounded-[10px]"
            initial={false}
            animate={{ left: geom.hole.left, top: geom.hole.top, width: geom.hole.width, height: geom.hole.height }}
            transition={spring}
            style={{
              boxShadow:
                "0 0 0 100vmax rgba(8,6,3,0.84), 0 0 46px 6px rgba(201,162,63,0.34), inset 0 0 0 1px rgba(201,162,63,0.55)",
            }}
          />
        ) : (
          // A centered step over a live scene (e.g. arriving back at the lobby) keeps the scene visible
          // behind a lighter veil; the sceneless welcome / finish steps get a fuller dark backdrop.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10"
            style={{ background: step.chapter === "welcome" || step.chapter === "done" ? "rgba(8,6,3,0.86)" : "rgba(8,6,3,0.5)" }}
          />
        ))}

      {/* The coach card — the usher's aside. Slides between focuses; content crossfades per step. */}
      <motion.div
        ref={cardRef}
        className="panel absolute z-30 w-[min(360px,calc(100vw-32px))] border border-line-2 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
        initial={false}
        animate={{ left: geom?.card.left ?? 0, top: geom?.card.top ?? 0, opacity: geom ? 1 : 0 }}
        transition={spring}
        style={{
          background: "linear-gradient(180deg,#17130b,#100d07)",
        }}
      >
        {/* a hairline gilt seam at the top edge, like a case-file rule */}
        <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-gilt/60 to-transparent" />
        <button
          type="button"
          onClick={close}
          aria-label="Skip tour"
          className="absolute right-3 top-3 z-40 font-mono text-[18px] leading-none text-mute backdrop-blur transition-colors hover:border-gilt hover:text-gilt"
        >
          ✕
        </button>
        <AnimatePresence mode="wait">
          <motion.div
            key={i}
            initial={reduce ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? undefined : { opacity: 0, y: -6 }}
            transition={{ duration: 0.22 }}
            className="px-[26px] py-[22px]"
          >
            <h2 className="font-display text-[27px] font-semibold leading-[1.08] tracking-[0.02em] text-cream">{step.title}</h2>
            <p className="mt-2.5 font-body text-[16.5px] leading-snug text-cream-dim">{step.body}</p>

            <div className="mt-5 flex items-center gap-2">
              {i > 0 && (
                <button
                  type="button"
                  onClick={() => go(-1)}
                  className="rounded-sm border border-line-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-mute transition-colors hover:border-gilt hover:text-gilt"
                >
                  Back
                </button>
              )}
              <div className="ml-auto flex items-center gap-3">
                <Dots total={total} at={i} />
                <button
                  ref={nextRef}
                  type="button"
                  onClick={() => (i === total - 1 ? finish() : go(1))}
                  className="rounded-sm border border-gilt px-4 py-2 font-mono text-[11.5px] uppercase tracking-[0.16em] text-gilt transition-colors hover:bg-gilt hover:text-ink"
                >
                  {step.primary} <span aria-hidden>›</span>
                </button>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/** A tiny lantern glyph — the tour's mark, a nod to the Court's banker's lamp. */
function LanternSeal() {
  return (
    <span className="relative flex h-5 w-5 flex-none items-center justify-center rounded-full border border-gilt/50">
      <span
        className="h-2 w-[7px] rounded-[50%_50%_48%_48%]"
        style={{ background: "radial-gradient(circle at 50% 35%, #fff0c0, #f0c552 55%, #9c7c20)", boxShadow: "0 0 8px 1px rgba(240,197,82,.6)" }}
      />
    </span>
  );
}

function Dots({ total, at }: { total: number; at: number }) {
  return (
    <span className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }).map((_, k) => (
        <span
          key={k}
          className={["h-1.5 rounded-full transition-all", k === at ? "w-4 bg-gilt" : "w-1.5 bg-line-2"].join(" ")}
        />
      ))}
    </span>
  );
}

// ── the mock lobby ─────────────────────────────────────────────────────────────
// A faithful, stripped-down copy of screens/Menu.tsx: the playbill frame + logo crest, the two
// chamfered `oct` cards with overhanging medallions, and the wallet card that swings from the
// "connect" CTA to a signed-in wallet with the faucet. Register targets: enter, historyCard, connect, faucet.
type Reg = (el: HTMLElement | null) => void;

function MockLobby({ register, step }: { register: (id: Target) => Reg; step: number }) {
  const connected = step > CONNECT_I; // the connect step shows the disconnected card; then it's signed in
  const balance = useCountUp(step >= FAUCET_I ? 250 : 0, step === FAUCET_I);

  return (
    <main className="relative flex min-h-full w-full items-center justify-center overflow-x-clip px-4 py-[clamp(2rem,5vh,3.5rem)] sm:px-6">
      <div className="relative w-full max-w-[1180px]">
        <LobbyFrame />
        <LobbySideMotifs side="left" />
        <LobbySideMotifs side="right" />
        <LobbyCrest />

        <div className="relative flex flex-col items-center px-[clamp(1.25rem,5vw,4rem)] pb-[clamp(1.5rem,4vh,2.75rem)] pt-[clamp(4.5rem,10vh,6.5rem)] text-center">
          <div className="eyebrow mb-[clamp(0.5rem,1.5vh,0.9rem)]">The People v/s The Hidden Hand</div>
          <h1 className="bg-gradient-to-b from-cream via-cream to-gilt-soft bg-clip-text font-display text-[clamp(2rem,3.5vw,4.25rem)] font-semibold uppercase leading-none tracking-[0.16em] text-transparent sm:tracking-[0.34em]">
            Turing Pits
          </h1>
          <div className="mt-[clamp(0.75rem,2vh,1.25rem)] font-body text-[clamp(1rem,1.8vw,1.1875rem)] italic text-gilt-soft">
            AI agents play Mafia. You predict the verdict.
          </div>

          <div className="mt-[clamp(0.5rem,1.5vh,0.9rem)] inline-flex items-center gap-2 font-mono text-[13px] uppercase tracking-[0.2em] text-mute underline decoration-line-2 underline-offset-4">
            New here? Take the guided tour
          </div>

          <div className="mt-[clamp(1.75rem,5vh,3rem)] grid w-full grid-cols-1 gap-[clamp(1rem,2.5vw,1.75rem)] sm:grid-cols-2">
            <MockMenuCard
              innerRef={register("enter")}
              title="Enter the Court"
              blurb="Watch a live match unfold and make predictions."
              cta="Watch live ›"
              icon={<PlayIcon />}
              status={<MockLiveChip />}
            />
            <MockMenuCard
              innerRef={register("historyCard")}
              title="Battle History"
              blurb="Every past battle, its verdicts, and winnings."
              cta="Open history ›"
              icon={<ChartIcon />}
            />
          </div>

          {/* filigree diamond divider, echoing the frame's ornaments */}
          <div className="my-[clamp(1rem,2.5vh,1.5rem)] flex items-center gap-3 text-gilt/40">
            <span className="h-px w-10 bg-gradient-to-l from-gilt/40 to-transparent" />
            <span className="h-1.5 w-1.5 rotate-45 border border-gilt/50" />
            <span className="h-px w-10 bg-gradient-to-r from-gilt/40 to-transparent" />
          </div>

          <MockWalletCard connected={connected} balance={balance} connectRef={register("connect")} faucetRef={register("faucet")} />
        </div>
      </div>
    </main>
  );
}

/** The ornate playbill frame — a double gilt hairline with rounded corners and four corner brackets. */
function LobbyFrame() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      <div className="absolute inset-0 rounded-[clamp(20px,3vw,34px)] border border-gilt/25" />
      <div className="absolute inset-[6px] rounded-[clamp(16px,2.6vw,28px)] border border-gilt/10" />
      <span className="absolute left-3 top-3 h-5 w-5 rounded-tl-[10px] border-l border-t border-gilt/45" />
      <span className="absolute right-3 top-3 h-5 w-5 rounded-tr-[10px] border-r border-t border-gilt/45" />
      <span className="absolute bottom-3 left-3 h-5 w-5 rounded-bl-[10px] border-b border-l border-gilt/45" />
      <span className="absolute bottom-3 right-3 h-5 w-5 rounded-br-[10px] border-b border-r border-gilt/45" />
    </div>
  );
}

/** The mask crest straddling the top break of the frame — the logo flanked by fading flourishes. */
function LobbyCrest() {
  return (
    <div className="absolute left-1/2 top-0 z-10 flex -translate-x-1/2 -translate-y-[30%] items-center gap-[clamp(0.75rem,2vw,1.25rem)]">
      <LobbyFlourish dir="left" />
      <img
        src="/Logo.png"
        alt="Turing Pits crest"
        className="h-[clamp(96px,13vw,128px)] w-[clamp(96px,13vw,128px)] shrink-0 object-contain [filter:drop-shadow(0_0_26px_rgba(201,162,63,0.3))]"
      />
      <LobbyFlourish dir="right" />
    </div>
  );
}

function LobbyFlourish({ dir }: { dir: "left" | "right" }) {
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

/** Ambient theatre-of-the-market motifs down each frame edge (decorative; hidden where the frame gets tight). */
function LobbySideMotifs({ side }: { side: "left" | "right" }) {
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

/** The live-status pull-through cue on the primary card. */
function MockLiveChip() {
  return (
    <span className="flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-convict animate-livepulse" />
      In session · round 2 · ◈240 pot · predictions open
    </span>
  );
}

/** A chamfered lobby card with a medallion badge overhanging its top edge (screens/Menu.tsx MenuCard). */
function MockMenuCard(p: { innerRef: Reg; title: string; blurb: string; cta: string; icon: ReactNode; status?: ReactNode }) {
  return (
    <div ref={p.innerRef} className="relative">
      <div className="oct block w-full bg-gradient-to-b from-gilt/55 via-gilt/20 to-gilt/10 p-px text-center">
        <span className="oct flex h-full flex-col items-center bg-ink-2 px-[clamp(1rem,2.5vw,1.6rem)] pb-[clamp(1.1rem,3vh,1.5rem)] pt-[clamp(2.35rem,4.5vh,2.75rem)]">
          <span className="font-display text-[clamp(1.25rem,2.6vw,1.6rem)] uppercase tracking-[0.08em] text-cream">{p.title}</span>
          <span className="mt-2 max-w-[26ch] font-body text-[clamp(0.875rem,1.35vw,0.975rem)] leading-snug text-cream-dim">{p.blurb}</span>
          {p.status && <span className="mt-3 block">{p.status}</span>}
          <span className="mt-[clamp(0.8rem,2vh,1.15rem)] font-mono text-[11.5px] uppercase tracking-[0.2em] text-gilt">{p.cta}</span>
        </span>
      </div>
      <span className="pointer-events-none absolute -top-6 left-1/2 flex h-12 w-12 -translate-x-1/2 items-center justify-center rounded-full bg-ink-2 text-gilt shadow-[0_0_24px_rgba(201,162,63,0.3)] ring-1 ring-gilt/70">
        <span className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-gilt/30" />
        {p.icon}
      </span>
    </div>
  );
}

/** The wallet as a chamfered bar (screens/Menu.tsx WalletCard) — disconnected CTA, or the signed-in wallet. */
function MockWalletCard({ connected, balance, connectRef, faucetRef }: { connected: boolean; balance: number; connectRef: Reg; faucetRef: Reg }) {
  if (!connected) {
    return (
      <div className="oct mx-auto w-full max-w-[460px] bg-gradient-to-b from-gilt/45 via-gilt/15 to-gilt/10 p-px">
        <div className="oct bg-ink-2 px-6 py-[clamp(1.5rem,4vh,1.9rem)] text-center">
          <div className="font-display text-[24px] uppercase tracking-[0.06em] text-cream">Connect to predict</div>
          <p className="mx-auto mt-2 max-w-[360px] font-body text-[14px] leading-snug text-cream-dim">
            CHIP is free mock test money. Connect once, then place predictions with{" "}
            <span className="text-cream">no pop-up on every prediction</span> — the relayer covers gas.
          </p>
          <div
            ref={connectRef}
            className="mx-auto mt-5 w-full max-w-[300px] rounded-sm border border-gilt px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.18em] text-gilt"
          >
            Connect wallet
          </div>
          <div className="mx-auto mt-3 block w-full font-mono text-[11px] uppercase tracking-[0.14em] text-mute underline decoration-line-2 underline-offset-4">
            No wallet? Play as guest ›
          </div>
        </div>
      </div>
    );
  }

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
              <span className="eyebrow">Session wallet</span>
              <span className="truncate font-mono text-[11px] tracking-[0.1em] text-mute">0x7a3f…c2d9 · 0G Galileo</span>
            </div>

            <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
              <span className="font-mono text-[clamp(1.35rem,3vw,1.65rem)] tabular-nums tracking-[0.02em] text-cream">
                {balance.toFixed(2)}
                <span className="ml-1.5 text-[12px] tracking-[0.12em] text-mute">CHIP</span>
              </span>
              <span
                ref={faucetRef}
                className="shrink-0 rounded-sm border border-line-2 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim"
              >
                Get test CHIP
              </span>
            </div>

            <div className="mt-4 border-t border-line pt-4">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="flex min-w-[11rem] flex-1 flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.14em] text-cream-dim">Your handle:</span>
                  <span className="min-w-0 flex-1 basis-[9rem] truncate font-display text-[18px] font-semibold tracking-[0.02em] text-cream">Spectator-7a3f</span>
                </div>
                <span className="shrink-0 rounded-sm border border-gilt px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">Edit</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── lobby medallion + motif icons (copied from screens/Menu.tsx) ─────────────────────────────── */
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

// ── the mock courtroom ──────────────────────────────────────────────────────────
// A faithful, stripped-down copy of the desktop screens/Live.tsx three-pane arena: the DesktopHeader,
// the full Bench (tribunal/Bench.tsx), the Court stage (tribunal/Court.tsx) with its vote board / lamp /
// transport, and the reworked "Markets" panel (tribunal/Verdict.tsx) — a compact header + countdown, a
// list of collapsible market rows, and the pinned action bar. Register targets: back, bench, court, wagers, bet.
const MOCK_SEATS = [
  { n: "Vera", b: "the prosecutor", state: "speaking" as const },
  { n: "Cato", b: "the skeptic", state: "voted" as const, votes: 2 },
  { n: "Mona", b: "the quiet one", state: "alive" as const },
  { n: "Rex", b: "the loudmouth", state: "alive" as const },
  { n: "Iris", b: "the newcomer", state: "dead" as const },
];

function MockCourt({ register, step, wide }: { register: (id: Target) => Reg; step: number; wide: boolean }) {
  const picked = step >= BET_I;
  // What this step is spotlighting — drives which panel opens on the mobile layout below.
  const target = STEPS[step]?.target;

  // ── Narrow: the real screens/Live.tsx mobile layout — a compact header, the Court as the whole stage,
  //    and a persistent predictions dock. The bench and the wagers stay COLLAPSED (a header button / the
  //    dock) and only open — as the real drawer / bottom-sheet — on the step that is actually about them. ──
  if (!wide) {
    const benchOpen = target === "bench";
    const wagersOpen = target === "wagers" || target === "bet";
    return (
      <main className="relative flex h-full w-full flex-col overflow-hidden">
        <MockMobileHeader backRef={register("back")} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <MockCourtStage innerRef={register("court")} />
        </div>
        <MockBottomDock />

        {benchOpen && <MockBenchDrawer benchRef={register("bench")} />}
        {wagersOpen && <MockWagersSheet wagersRef={register("wagers")} betRef={register("bet")} picked={picked} />}
      </main>
    );
  }

  // ── Desktop: the full three-pane courtroom — bench rail, the Court, and the Markets panel side by side. ──
  return (
    <main className="flex h-full w-full flex-col overflow-hidden px-6 pb-4">
      <MockCourtHeader backRef={register("back")} wide={wide} />
      <div className="mt-4 grid min-h-0 flex-1 grid-cols-[248px_minmax(0,1fr)_clamp(380px,38vw,560px)] overflow-hidden">
        <MockBench innerRef={register("bench")} />
        <MockCourtStage innerRef={register("court")} />
        <MockMarkets innerRef={register("wagers")} betRef={register("bet")} picked={picked} />
      </div>
    </main>
  );
}

/** The masthead — the full desktop header (screens/Live.tsx DesktopHeader) on wide, and a compact variant
 *  on narrow (mirroring MobileHeader) so the wordmark + wallet + audio never overflow a phone. */
function MockCourtHeader({ backRef, wide }: { backRef: Reg; wide: boolean }) {
  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b hairline pb-3 pt-3 sm:gap-4">
      <span ref={backRef} className="font-mono text-[20px] leading-none text-mute sm:text-[24px]">
        ‹
      </span>

      <div className="min-w-0 flex-1 text-left sm:flex-none">
        <div className="flex items-center gap-2 sm:gap-3">
          <span className="truncate font-display text-[17px] font-semibold uppercase leading-none tracking-[0.2em] text-gilt sm:text-[24px] sm:tracking-[0.3em]">
            Turing Pits
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-gilt sm:text-[10px]">
            <span className="h-1.5 w-1.5 rounded-full bg-convict animate-livepulse" />
            In session · live
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.16em] text-gilt sm:text-[11px] sm:tracking-[0.18em]">
          Day · round 2<span className="text-cream"> · Vera speaking</span>
        </div>
      </div>

      {/* Wallet capsule + audio controls only where there's room; a phone keeps the header to identity. */}
      {wide && (
        <div className="ml-auto flex items-center gap-3">
          <span className="flex h-9 items-center gap-2 rounded-full border border-line-2 bg-ink-2 px-3.5 font-mono text-[12px] tracking-[0.06em] text-cream">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-acquit shadow-[0_0_8px_rgba(127,160,126,0.8)]" />
            225.000 CHIP
          </span>
          <div className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-gilt bg-ink-2 text-[15px] text-gilt">♪</span>
            <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line-2 bg-ink-2 text-mute">
              <MockSpeakerIcon />
            </span>
          </div>
        </div>
      )}
    </header>
  );
}

function MockSpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable="false">
      <path d="M3 6h2.5L9 3.2v9.6L5.5 10H3z" fill="currentColor" />
      <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
        <path d="M11.2 6.1a3 3 0 0 1 0 3.8" />
        <path d="M12.9 4.7a5.2 5.2 0 0 1 0 6.6" />
      </g>
    </svg>
  );
}

/** The compact sticky mobile masthead (screens/Live.tsx MobileHeader) — case identity, liveness, the
 *  audio controls, and the bench button that (in the real app) opens the bench drawer. */
function MockMobileHeader({ backRef }: { backRef: Reg }) {
  return (
    <header className="flex shrink-0 items-center gap-2.5 border-b hairline px-4 py-2.5">
      <span ref={backRef} className="font-mono text-[20px] leading-none text-mute">
        ‹
      </span>

      <div className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-2">
          <span className="truncate font-display text-[17px] font-semibold uppercase tracking-[0.2em] text-cream">Turing Pits</span>
          <span className="flex shrink-0 items-center gap-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-gilt">
            <span className="h-1.5 w-1.5 rounded-full bg-convict animate-livepulse" />
            live
          </span>
        </div>
        <div className="truncate font-mono text-[10px] uppercase tracking-[0.16em] text-gilt">
          Day · round 2<span className="text-cream"> · Vera speaking</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-gilt bg-ink-2 text-[15px] text-gilt">♪</span>
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-line-2 bg-ink-2 text-mute">
          <MockSpeakerIcon />
        </span>
      </div>

      <span className="flex h-9 items-center gap-1.5 rounded-full border border-line-2 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute">
        <span className="text-[14px] leading-none">☰</span>
        <span className="tabular-nums tracking-normal">
          <span className="text-cream">4</span>/5
        </span>
      </span>
    </header>
  );
}

/** The persistent wager dock at the foot of the mobile stage (screens/Live.tsx BottomDock) — the collapsed
 *  predictions surface that (in the real app) raises the full Wagers sheet. */
function MockBottomDock() {
  return (
    <div className="shrink-0 border-t border-line-2 bg-ink-2/95 backdrop-blur">
      <div className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow">The Predictions</span>
            <span className="text-[10px] text-gilt">●</span>
          </div>
          <div className="mt-0.5 truncate font-mono text-[12px] uppercase tracking-[0.12em] text-gilt">Predictions open · predict now</div>
        </div>
        <span className="shrink-0 font-mono text-[18px] tabular-nums tracking-[0.06em] text-gilt">01:48</span>
        <span className="shrink-0 rounded-sm border border-gilt px-4 py-2 font-mono text-[12px] uppercase tracking-[0.14em] text-gilt">Predict ›</span>
      </div>
    </div>
  );
}

/** The bench slid in from the left as a drawer (screens/Live.tsx BenchDrawer). No backdrop of its own — the
 *  tour's lantern already dims everything but the spotlight. */
function MockBenchDrawer({ benchRef }: { benchRef: Reg }) {
  return (
    <aside className="absolute inset-y-0 left-0 z-20 flex w-[min(86vw,340px)] flex-col border-r border-line-2 shadow-[0_0_60px_rgba(0,0,0,0.6)]">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MockBench innerRef={benchRef} />
      </div>
    </aside>
  );
}

/** The full Markets panel raised from the bottom as a sheet (screens/Live.tsx WagersSheet). */
function MockWagersSheet({ wagersRef, betRef, picked }: { wagersRef: Reg; betRef: Reg; picked: boolean }) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-20 flex h-[86%] flex-col overflow-hidden rounded-t-2xl border-t border-line-2 shadow-[0_-10px_60px_rgba(0,0,0,0.6)]">
      <div className="flex shrink-0 justify-center bg-[#131009] pt-3 pb-1">
        <span aria-hidden className="h-1 w-10 rounded-full bg-line-2" />
      </div>
      <div className="min-h-0 flex-1">
        <MockMarkets innerRef={wagersRef} betRef={betRef} picked={picked} />
      </div>
    </div>
  );
}

/** The bench (tribunal/Bench.tsx) — every agent's seat, its state, and any votes drawn. */
function MockBench({ innerRef }: { innerRef: Reg }) {
  return (
    <section ref={innerRef} className="panel h-full min-h-0 overflow-y-auto border-r border-line px-5 py-5">
      <div className="eyebrow mb-4 border-b hairline pb-3">The Bench</div>
      <div>
        {MOCK_SEATS.map((s) => {
          const speaking = s.state === "speaking";
          const dead = s.state === "dead";
          return (
            <div
              key={s.n}
              className={[
                "relative -mx-2.5 border-l-2 px-2.5 py-3 transition-colors",
                speaking ? "border-gilt bg-gradient-to-r from-gilt/10 to-transparent" : "border-transparent",
              ].join(" ")}
            >
              <div className={["flex w-full items-center gap-3", dead ? "opacity-50" : ""].join(" ")}>
                <span
                  className={[
                    "flex h-7 w-7 flex-none items-center justify-center rounded-full border font-display text-[16px] font-semibold",
                    speaking ? "border-gilt text-gilt shadow-[0_0_14px_rgba(201,162,63,0.28)]" : "border-line-2 text-mute",
                  ].join(" ")}
                >
                  {s.n[0]}
                </span>
                <span className="leading-snug">
                  <span
                    className={[
                      "font-display text-[17px] font-semibold tracking-[0.12em]",
                      dead ? "text-mute-2 line-through decoration-convict" : speaking ? "text-lamp" : "text-cream",
                    ].join(" ")}
                  >
                    {s.n}
                  </span>
                  <br />
                  <span className={["text-[13.5px] italic", dead ? "text-mute-2" : "text-mute"].join(" ")}>{s.b}</span>
                </span>
                <span className="ml-auto text-right">
                  {s.votes ? (
                    <span className="inline-flex items-center gap-1 font-mono text-[13px] text-gilt">
                      <span className="tracking-[-2px]">{"▌".repeat(s.votes)}</span>
                      {s.votes}
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** The court stage (tribunal/Court.tsx) — the vote board, the banker's lamp, a spoken scene, and the transport. */
function MockCourtStage({ innerRef }: { innerRef: Reg }) {
  return (
    <section ref={innerRef} className="panel relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* the vote board — the aggregate climax of a day vote */}
      <div className="absolute left-3 top-3 z-30 w-[clamp(150px,42vw,196px)] rounded-sm border border-line-2 bg-[#131009]/90 px-3 py-2.5 backdrop-blur-sm">
        <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
          <span>The vote · R2</span>
          <span className="tabular-nums text-gilt-soft">2/4</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line-2">
          <div className="h-full bg-gilt" style={{ width: "50%" }} />
        </div>
        <div className="mt-2 font-display text-[14px] tracking-[0.07em]">
          <span className="text-cream">
            CATO<span className="ml-1 font-mono text-[12px] text-gilt">·2</span>
          </span>
        </div>
        <div className="mt-0.5 font-body text-[11.5px] italic leading-tight text-mute">2 still to vote</div>
      </div>

      {/* the transcript toggle */}
      <div className="absolute right-3 top-3 z-40 flex flex-col items-end gap-2">
        <span className="rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-mute">Transcript · 6</span>
      </div>

      {/* the banker's lamp — signature element */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-10 left-1/2 h-[clamp(260px,42vh,420px)] w-[clamp(320px,90vw,560px)] -translate-x-1/2 blur-[2px]"
        style={{ background: "radial-gradient(closest-side, rgba(240,197,82,.20), rgba(240,197,82,.06) 45%, transparent 72%)" }}
      >
        <span
          className="absolute left-1/2 top-[30px] h-5 w-[13px] -translate-x-1/2 rounded-[50%_50%_48%_48%]"
          style={{ background: "radial-gradient(circle at 50% 35%, #fff0c0, #f0c552 55%, #9c7c20)", boxShadow: "0 0 22px 6px rgba(240,197,82,.5)" }}
        />
      </div>

      {/* the scene */}
      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto px-5 pt-3.5 pb-3 sm:px-8">
        <div className="my-auto flex w-full flex-col items-center py-3">
          <div className="mb-7 mt-1.5 flex flex-col items-center text-center">
            <div className="font-mono text-[14px] uppercase tracking-[0.3em] text-gilt">The vote</div>
            <div className="mt-1.5 font-body text-[18px] italic text-mute">they commit and make their case</div>
          </div>

          <h2
            className="text-center font-display text-[clamp(2rem,7vw,2.875rem)] font-bold leading-none tracking-[0.16em] text-cream sm:tracking-[0.2em]"
            style={{ textShadow: "0 2px 30px rgba(240,197,82,.18)" }}
          >
            VERA
          </h2>
          <div className="mb-7 mt-2.5 text-center font-body text-[18px] italic text-gilt-soft">
            <span className="mx-2 text-mute-2">—</span>
            the prosecutor
            <span className="mx-2 text-mute-2">—</span>
          </div>

          <blockquote className="min-h-[120px] w-full max-w-[34.5rem] text-center font-body text-[clamp(1.25rem,4.6vw,2rem)] not-italic leading-[1.55] text-cream sm:leading-[1.62]">
            <span aria-hidden className="mr-1 align-[-0.25em] font-display text-[1.5em] leading-[0] text-gilt-soft">“</span>
            Cato has dodged every question about last night. I think he is Mafia — and my vote says so.
            <span aria-hidden className="ml-1 align-[-0.25em] font-display text-[1.5em] leading-[0] text-gilt-soft">”</span>
          </blockquote>

          <div className="mt-4 min-h-[1.3em] font-mono text-[13px] uppercase tracking-[0.22em] text-gilt">▸ votes to convict CATO</div>
        </div>
      </div>

      {/* the pinned playback transport */}
      <div className="relative z-30 flex shrink-0 items-center justify-end gap-3 px-4 pb-3 pt-1.5">
        <div className="flex items-center gap-1 rounded-full border border-line-2 bg-[#131009]/90 px-1.5 py-1 backdrop-blur-sm">
          <span className="flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] leading-none text-mute">◀</span>
          <span className="flex h-7 w-9 items-center justify-center rounded-full border border-line-2 font-mono text-[12px] leading-none text-mute">❚❚</span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] leading-none text-mute">▶</span>
        </div>
      </div>
    </section>
  );
}

/** The "Markets" wagers panel (tribunal/Verdict.tsx) — compact header + countdown, a list of markets
 *  (the faction market expanded), and the pinned action bar (the bet-demo target). */
function MockMarkets({ innerRef, betRef, picked }: { innerRef: Reg; betRef: Reg; picked: boolean }) {
  return (
    <aside ref={innerRef} className="panel flex h-full min-h-0 flex-col overflow-hidden border-l border-line" style={{ backgroundColor: "#131009" }}>
      {/* ── Compact header — the Markets mark + case status, the "your book" roll-up, and the countdown. ── */}
      <div className="flex-none border-b hairline px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lamp animate-lamppulse" />
            <span className="shrink-0 font-mono text-[12px] font-semibold uppercase tracking-[0.26em] text-gilt">Markets</span>
            <span className="truncate font-mono text-[9.5px] uppercase tracking-[0.14em] text-mute">Live · Case #41 · R2</span>
          </div>
          {picked && (
            <div className="flex shrink-0 items-baseline gap-1.5 font-mono tabular-nums">
              <span className="text-[9px] uppercase tracking-[0.16em] text-mute-2">your holding</span>
              <span className="text-[12px] text-cream-dim">◈25.00</span>
              <span className="text-mute-2">→</span>
              <span className="text-[12px] text-gilt">◈61.00</span>
            </div>
          )}
        </div>

        <div className="mt-2.5 border-l-2 border-gilt pl-2.5">
          <div className="flex items-center justify-between gap-2.5">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.2em] text-gilt">Market close in</span>
            <span className="font-mono text-[15px] font-semibold tabular-nums tracking-[0.08em] text-gilt">01:48</span>
          </div>
          <div className="mt-1.5 h-0.5 bg-line">
            <div className="h-full bg-gilt" style={{ width: "68%" }} />
          </div>
        </div>
      </div>

      {/* ── The market list — the headline faction market expanded, the rest collapsed. ── */}
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* the expanded faction market */}
        <div className="border-b border-l-2 border-l-gilt hairline" style={{ backgroundColor: "#1b1610" }}>
          <div className="flex w-full flex-col gap-1.5 px-3 py-2.5 text-left">
            <div className="flex items-center gap-2.5">
              <span className="shrink-0 border border-gilt/50 px-[5px] py-[1.5px] font-mono text-[8.5px] uppercase tracking-[0.16em] text-gilt">OPEN</span>
              <span className="min-w-0 flex-1 truncate font-display text-[19px] font-medium leading-none text-cream">Faction win</span>
              <span className="inline-block w-3 shrink-0 rotate-90 text-center font-mono text-[11px] leading-none text-mute">▸</span>
            </div>
          </div>
          <div className="px-3 pb-3">
            <div className="mb-2.5 font-display text-[17px] italic leading-tight text-cream-dim">Will Mafia win?</div>
            <div className="grid grid-cols-2 gap-2">
              <MockOutcomeCard eyebrow="Mafia faction" eyebrowClass="text-[#d98a55]" label="ACQUITTED" accent="text-[#d98a55]" mult="×2.40" pct={42} pool="100.80" selected={picked} />
              <MockOutcomeCard eyebrow="Town faction" eyebrowClass="text-acquit" label="CONVICTED" accent="text-acquit" mult="×1.70" pct={58} pool="139.20" selected={false} />
            </div>
          </div>
        </div>

        {/* collapsed markets, for context */}
        <MockCollapsedRow badge="OPEN" badgeCls="text-gilt border-gilt/50" title="Who is Mafia?" chips={[{ t: "◈96.00", cls: "text-mute" }, { t: "CATO ×2.10", cls: "text-cream" }]} />
        <MockCollapsedRow badge="OPEN" badgeCls="text-gilt border-gilt/50" title="Round 2 vote" chips={[{ t: "◈64.00", cls: "text-mute" }, { t: "CATO ×1.90", cls: "text-cream" }, { t: "you ◈10.00", cls: "border-l-2 border-gilt pl-1.5 text-gilt" }]} />
        <MockCollapsedRow badge="SOON" badgeCls="text-mute border-line-2" dim title="Night 2 kill" chips={[{ t: "opens at nightfall", cls: "text-mute" }]} />
      </div>

      {/* ── The pinned action bar — the "place a prediction" target. ── */}
      <div ref={betRef} className="flex-none border-t border-gilt px-4 py-3 shadow-[0_-14px_24px_-18px_rgba(0,0,0,0.9)]" style={{ backgroundColor: "#100d07" }}>
        <div className="mb-2 flex items-baseline justify-between gap-2.5">
          <div className="min-w-0 truncate">
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-mute">BET ON </span>
            <span className="font-display text-[18px] font-semibold text-cream">ACQUITTED</span>
            <span className="ml-1.5 font-mono text-[12px] tabular-nums text-cream-dim">×2.40</span>
            <span className="ml-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-gilt/70">· no gas</span>
          </div>
          <div className="shrink-0 text-right">
            <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-mute-2">CAN WIN</div>
            <div className="font-mono text-[16px] font-semibold tabular-nums text-gilt">◈61.00</div>
          </div>
        </div>

        <div className="flex items-stretch gap-2">
          <div className="flex items-center border border-line-2 bg-ink">
            <span className="flex h-[42px] w-[34px] items-center justify-center border-r hairline font-mono text-[17px] leading-none text-cream-dim">−</span>
            <span className="flex w-[76px] items-center justify-center font-mono text-[15px] tabular-nums text-cream">25.0</span>
            <span className="flex h-[42px] w-[34px] items-center justify-center border-l hairline font-mono text-[17px] leading-none text-cream-dim">+</span>
          </div>
          <div className="flex h-[42px] flex-1 items-center justify-center bg-gilt font-mono text-[12px] font-semibold uppercase tracking-[0.14em] text-ink">Place bet ◈25.00</div>
        </div>
      </div>
    </aside>
  );
}

/** A wide two-up outcome card (tribunal/Verdict.tsx OutcomeCard). */
function MockOutcomeCard({ eyebrow, eyebrowClass, label, accent, mult, pct, pool, selected }: { eyebrow: string; eyebrowClass: string; label: string; accent: string; mult: string; pct: number; pool: string; selected: boolean }) {
  return (
    <div className={["relative border-l-2 px-3 py-2.5 text-left", selected ? "border-l-gilt bg-gilt/[0.07]" : "border-l-line"].join(" ")}>
      <div className={["truncate font-mono text-[9px] uppercase tracking-[0.2em]", eyebrowClass].join(" ")}>{eyebrow}</div>
      <div className={["mt-0.5 font-display text-[22px] font-semibold leading-none tracking-[0.02em]", selected ? "text-lamp" : accent].join(" ")}>{label}</div>
      <div className="mt-2.5 flex items-baseline gap-1.5">
        <span className="rounded-[1px] px-1 font-mono text-[22px] font-semibold leading-none tabular-nums text-cream">{mult}</span>
      </div>
      <div className="mt-2 flex items-center justify-between font-mono text-[10px] tabular-nums text-mute">
        <span>{pct}% of pot</span>
        <span>◈{pool}</span>
      </div>
      <div className="mt-2 h-0.5 bg-line">
        <div className={["h-full", selected ? "bg-gilt" : "bg-gilt-soft"].join(" ")} style={{ width: `${pct}%` }} />
      </div>
      {selected && <div className="mt-2.5 border-l-2 border-gilt pl-1.5 font-mono text-[9.5px] tracking-[0.06em] text-gilt">◈25.00 yours</div>}
    </div>
  );
}

/** A collapsed market row (tribunal/Verdict.tsx MarketRow header + peek chips). */
function MockCollapsedRow({ badge, badgeCls, title, chips, dim }: { badge: string; badgeCls: string; title: string; chips: { t: string; cls: string }[]; dim?: boolean }) {
  return (
    <div className={["border-b border-l-2 hairline", dim ? "border-l-mute" : "border-l-gilt"].join(" ")}>
      <div className={["flex w-full flex-col gap-1.5 px-3 py-2.5 text-left", dim ? "opacity-55" : ""].join(" ")}>
        <div className="flex items-center gap-2.5">
          <span className={["shrink-0 border px-[5px] py-[1.5px] font-mono text-[8.5px] uppercase tracking-[0.16em]", badgeCls].join(" ")}>{badge}</span>
          <span className={["min-w-0 flex-1 truncate font-display text-[19px] font-medium leading-none", dim ? "text-cream-dim" : "text-cream"].join(" ")}>{title}</span>
          <span className="inline-block w-3 shrink-0 text-center font-mono text-[11px] leading-none text-mute">▸</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] tabular-nums">
          {chips.map((c, i) => (
            <span key={i} className={c.cls}>
              {c.t}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── the mock battle history ─────────────────────────────────────────────────────
function MockHistory({ register }: { register: (id: Target) => (el: HTMLElement | null) => void }) {
  return (
    <main className="mx-auto flex h-full w-full max-w-[860px] flex-col px-6 py-7">
      <div className="flex items-center gap-4 font-mono text-[11px] uppercase tracking-[0.18em] text-mute">
        <span>‹ Lobby</span>
        <span>Watch live</span>
      </div>

      <header className="mt-5 border-b hairline pb-4">
        <div className="eyebrow mb-2">The record</div>
        <h1 className="font-display text-[clamp(2rem,5vw,2.5rem)] font-semibold uppercase leading-none tracking-[0.18em] text-cream">
          Battle History
        </h1>
      </header>

      <div className="mt-4 border border-gilt/40 bg-gilt/[0.05] px-4 py-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-gilt">You can reclaim</div>
        <div className="mt-1 font-mono tabular-nums text-cream">
          <span className="text-[16px]">◈ 61.00</span>
          <span className="ml-2 text-[12px] text-mute">across 1 battle</span>
        </div>
      </div>

      <ul className="mt-4 flex flex-col gap-px bg-line">
        {/* the claimable battle — the spotlight target (holds both the evidence links and the claim) */}
        <li ref={register("record")} className="panel flex flex-col gap-3 border-l-2 border-gilt px-5 py-4">
          <div className="flex items-center gap-4">
            <div className="w-16 flex-none">
              <div className="font-mono text-[12px] text-cream">#41</div>
              <div className="font-mono text-[10px] tracking-[0.06em] text-mute">case 9f3c2a</div>
            </div>
            <div className="flex-1">
              <div className="font-display text-[20px] tracking-[0.08em] text-convict">Acquitted</div>
              <div className="mt-0.5 font-mono text-[11px] tracking-[0.06em] text-mute">5 seats · pot ◈ 240.00</div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] tracking-[0.06em]">
                <span className="uppercase tracking-[0.12em] text-mute-2">0G evidence ·</span>
                <span className="inline-flex items-center gap-1 text-gilt-soft">
                  transcript <span className="text-mute">0x7b…e12</span> <span aria-hidden>↗</span>
                </span>
                <span className="inline-flex items-center gap-1 text-gilt-soft">
                  personas <span className="text-mute">0x2d…9af</span> <span aria-hidden>↗</span>
                </span>
              </div>
            </div>
            <span className="flex-none rounded-sm border border-acquit px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-acquit">
              Collect all ◈ 61.00
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t hairline pt-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-mute">Your pots ·</span>
            <span className="rounded-sm border border-line-2 px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-cream-dim">
              Faction verdict · ◈ 25.00
            </span>
            <span className="rounded-sm border border-line-2 px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.12em] text-cream-dim">
              Night 2 kill · ◈ 10.00
            </span>
          </div>
        </li>

        {/* a settled battle for context */}
        <li className="panel flex items-center gap-4 px-5 py-4">
          <div className="w-16 flex-none">
            <div className="font-mono text-[12px] text-cream">#40</div>
            <div className="font-mono text-[10px] tracking-[0.06em] text-mute">case 4a1c7d</div>
          </div>
          <div className="flex-1">
            <div className="font-display text-[20px] tracking-[0.08em] text-acquit">Convicted</div>
            <div className="mt-0.5 font-mono text-[11px] tracking-[0.06em] text-mute">5 seats · pot ◈ 180.00</div>
          </div>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-mute">Staked</span>
        </li>
      </ul>
    </main>
  );
}

/** A quick count-up for the faucet demo — jumps instantly if reduced motion or when not active. */
function useCountUp(target: number, active: boolean) {
  const [v, setV] = useState(target);
  const reduce = useReducedMotion();
  useEffect(() => {
    if (!active || reduce || target === 0) {
      setV(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const from = 0;
    const dur = 700;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setV(from + (target - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    setV(from);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, active, reduce]);
  return v;
}
