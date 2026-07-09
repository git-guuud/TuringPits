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
const TRAY_I = idxOf("tray");

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
      {/* The mock stage sits at full brightness; the lantern overlay (below) dims all but the focus. */}
      <div aria-hidden className="absolute inset-0 z-0">
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
function MockLobby({ register, step }: { register: (id: Target) => (el: HTMLElement | null) => void; step: number }) {
  const connected = step > CONNECT_I; // the connect step shows the disconnected card; then it's signed in
  const balance = useCountUp(step >= FAUCET_I ? 250 : 0, step === FAUCET_I);

  return (
    <main className="flex h-full w-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-[720px] text-center">
        <div className="eyebrow mb-2">The People v/s The Hidden Hand</div>
        <h1 className="font-display text-[clamp(2rem,7vw,3.25rem)] font-semibold uppercase leading-none tracking-[0.4em] text-cream">
          Turing Pits
        </h1>
        <div className="mt-3 font-body text-[16px] italic text-gilt-soft">
          AI agents play Mafia. You predict the verdict.
        </div>

        <div className="mt-8 grid grid-cols-1 gap-px bg-line sm:grid-cols-2">
          <div ref={register("enter")} className="panel flex flex-col items-start border-l-2 border-gilt/40 px-6 py-7 text-left">
            <div className="eyebrow mb-3">The arena</div>
            <div className="font-display text-[26px] tracking-[0.06em] text-cream">Enter the Court</div>
            <div className="mt-2 font-body text-[14px] leading-snug text-cream-dim">
              Watch a live match unfold and make predictions.
            </div>
            <div className="mt-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-convict animate-livepulse" />
              In session · round 2 · ◈240 pot
            </div>
            <div className="mt-5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt">Watch live ›</div>
          </div>
          <div ref={register("historyCard")} className="panel flex flex-col items-start px-6 py-7 text-left">
            <div className="eyebrow mb-3">The record</div>
            <div className="font-display text-[26px] tracking-[0.06em] text-cream">Battle History</div>
            <div className="mt-2 font-body text-[14px] leading-snug text-cream-dim">
              Every past battle, its verdict, and winnings.
            </div>
            <div className="mt-5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt">Browse history ›</div>
          </div>
        </div>

        {/* The wallet card, swinging from "connect" to a signed-in wallet with the faucet. */}
        <div className="panel hairline mx-auto mt-8 w-full max-w-[440px] border px-6 py-5">
          {!connected ? (
            <div className="text-center">
              <div className="font-display text-[22px] tracking-[0.04em] text-cream">Connect to predict</div>
              <p className="mx-auto mt-1.5 max-w-[360px] font-body text-[13.5px] leading-snug text-cream-dim">
                CHIP is free mock test money. Connect once, then place predictions with{" "}
                <span className="text-cream">no pop-up on every prediction</span>.
              </p>
              <div
                ref={register("connect")}
                className="mx-auto mt-5 w-full max-w-[300px] rounded-sm border border-gilt px-5 py-2.5 font-mono text-[12px] uppercase tracking-[0.16em] text-gilt"
              >
                Connect wallet
              </div>
              <div className="mt-3 font-mono text-[11px] uppercase tracking-[0.14em] text-mute underline decoration-line-2 underline-offset-4">
                No wallet? Play as guest ›
              </div>
            </div>
          ) : (
            <div className="text-left">
              <div className="flex items-center justify-between gap-3">
                <span className="eyebrow">Session wallet</span>
                <span className="font-mono text-[11px] tracking-[0.1em] text-mute">0x7a…3f9 · 0G Galileo</span>
              </div>
              <div ref={register("faucet")} className="mt-3 flex items-center justify-between gap-3 rounded-sm">
                <span className="font-mono text-[22px] tabular-nums tracking-[0.02em] text-cream">
                  ◈ {balance.toFixed(2)}
                  <span className="ml-1.5 text-[12px] tracking-[0.12em] text-mute">CHIP</span>
                </span>
                <span className="rounded-sm border border-gilt/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-gilt">
                  Get test CHIP
                </span>
              </div>
              <div className="mt-4 border-t border-line pt-4">
                <p className="mt-1.5 font-body text-[13px] leading-snug text-mute">
                  You’re signed in
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

// ── the mock courtroom ──────────────────────────────────────────────────────────
const MOCK_SEATS = [
  { n: "Vera", b: "the prosecutor", state: "speaking" as const },
  { n: "Cato", b: "the skeptic", state: "voted" as const },
  { n: "Mona", b: "the quiet one", state: "alive" as const },
  { n: "Rex", b: "the loudmouth", state: "alive" as const },
  { n: "Iris", b: "the newcomer", state: "dead" as const },
];

function MockCourt({
  register,
  step,
  wide,
}: {
  register: (id: Target) => (el: HTMLElement | null) => void;
  step: number;
  wide: boolean;
}) {
  const picked = step >= BET_I;
  const showTray = step === TRAY_I;

  const bench = (
    <section ref={register("bench")} className="panel min-h-0 overflow-hidden px-4 py-4">
      <div className="eyebrow mb-3 border-b hairline pb-2">The Bench</div>
      <div className="space-y-0.5">
        {MOCK_SEATS.map((s) => (
          <div
            key={s.n}
            className={[
              "-mx-2 flex items-center gap-2.5 border-l-2 px-2 py-2",
              s.state === "speaking" ? "border-gilt bg-gradient-to-r from-gilt/10 to-transparent" : "border-transparent",
            ].join(" ")}
          >
            <span
              className={[
                "flex h-6 w-6 flex-none items-center justify-center rounded-full border font-display text-[13px] font-semibold",
                s.state === "speaking"
                  ? "border-gilt text-gilt shadow-[0_0_10px_rgba(201,162,63,0.3)]"
                  : s.state === "dead"
                    ? "border-line-2 text-mute-2"
                    : "border-line-2 text-mute",
              ].join(" ")}
            >
              {s.n[0]}
            </span>
            <span className="min-w-0 leading-tight">
              <span
                className={[
                  "block truncate font-display text-[14px] font-semibold tracking-[0.08em]",
                  s.state === "dead" ? "text-mute-2 line-through decoration-convict" : s.state === "speaking" ? "text-lamp" : "text-cream",
                ].join(" ")}
              >
                {s.n}
              </span>
              <span className="block truncate text-[11.5px] italic text-mute">{s.b}</span>
            </span>
            {s.state === "voted" && (
              <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-gilt">
                <span className="tracking-[-2px]">▌▌</span>2
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );

  const court = (
    <section ref={register("court")} className="panel relative flex min-h-0 flex-col overflow-hidden">
      {/* the banker's lamp */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-8 left-1/2 h-[220px] w-[360px] -translate-x-1/2 blur-[2px]"
        style={{ background: "radial-gradient(closest-side, rgba(240,197,82,.18), rgba(240,197,82,.05) 45%, transparent 72%)" }}
      >
        <span
          className="absolute left-1/2 top-[22px] h-4 w-[11px] -translate-x-1/2 rounded-[50%_50%_48%_48%]"
          style={{ background: "radial-gradient(circle at 50% 35%, #fff0c0, #f0c552 55%, #9c7c20)", boxShadow: "0 0 18px 5px rgba(240,197,82,.5)" }}
        />
      </div>
      <div className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        <div className="font-mono text-[12px] uppercase tracking-[0.3em] text-gilt">The vote</div>
        <div className="mt-1 font-body text-[15px] italic text-mute">they commit and make their case</div>
        <h2
          className="mt-4 font-display text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-none tracking-[0.18em] text-cream"
          style={{ textShadow: "0 2px 30px rgba(240,197,82,.18)" }}
        >
          VERA
        </h2>
        <div className="mt-2 font-body text-[15px] italic text-gilt-soft">— the prosecutor —</div>
        <blockquote className="mt-5 max-w-[30rem] font-body text-[clamp(1.15rem,2.6vw,1.6rem)] leading-[1.5] text-cream">
          <span aria-hidden className="mr-1 align-[-0.25em] font-display text-[1.4em] leading-[0] text-gilt-soft">“</span>
          Cato has dodged every question about last night. I think he is Mafia — and my vote says so.
          <span aria-hidden className="ml-1 align-[-0.25em] font-display text-[1.4em] leading-[0] text-gilt-soft">”</span>
        </blockquote>
        <div className="mt-4 font-mono text-[12px] uppercase tracking-[0.22em] text-gilt">▸ votes to convict CATO</div>
      </div>
      <div className="relative z-10 flex shrink-0 items-center justify-end gap-2 px-4 pb-3">
        <div className="flex items-center gap-1 rounded-full border border-line-2 bg-[#131009]/90 px-1.5 py-1">
          <span className="flex h-6 w-6 items-center justify-center rounded-full font-mono text-[10px] text-mute">◀</span>
          <span className="flex h-6 w-8 items-center justify-center rounded-full border border-line-2 font-mono text-[10px] text-mute">❚❚</span>
          <span className="flex h-6 w-6 items-center justify-center rounded-full font-mono text-[10px] text-mute">▶</span>
        </div>
      </div>
    </section>
  );

  const wagers = (
    <aside ref={register("wagers")} className="panel flex min-h-0 flex-col overflow-hidden px-5 py-5">
      <div className="mb-4 flex items-center gap-2.5 border-b hairline pb-3 font-mono text-[15px] uppercase tracking-[0.24em] text-mute">
        Predictions
        <span className="inline-flex items-center gap-1.5 rounded-sm border border-gilt/40 px-2 py-0.5 font-mono text-[11.5px] uppercase tracking-[0.14em] text-gilt">
          <span className="h-1.5 w-1.5 rounded-full bg-current" />
          Open
        </span>
      </div>

      <div className="mb-3 flex items-baseline justify-between border-l-2 border-gilt/50 bg-gilt/[0.05] px-3.5 py-2.5">
        <span className="font-mono text-[14px] uppercase tracking-[0.16em] text-mute">Predictions close in</span>
        <span className="font-mono text-[26px] tabular-nums tracking-[0.08em] text-gilt">01:48</span>
      </div>

      {/* The headline faction market — the bet-demo target. */}
      <div ref={register("bet")} className="border border-gilt/50 bg-ink-2/40">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="font-mono text-[14px] uppercase tracking-[0.14em] text-cream">Faction verdict</span>
          <span className="rounded-sm border border-gilt/40 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-gilt">open</span>
        </div>
        <div className="border-t hairline px-4 pb-4 pt-3.5">
          <div className="mb-3.5 font-display text-[23px] leading-tight text-cream">Will the hidden hand walk free?</div>
          <div className="grid grid-cols-2 gap-3">
            <MockChoice label="ACQUITTED" eyebrow="Mafia faction" color="#d98a55" pctText="42% of pot" mult="×2.4" picked={picked} />
            <MockChoice label="CONVICTED" eyebrow="Town faction" color="#7fa07e" pctText="58% of pot" mult="×1.7" picked={false} />
          </div>

          <div className="mt-4 border-t hairline pt-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-11 w-11 items-center justify-center rounded-sm border border-line font-mono text-[24px] leading-none text-mute">−</span>
              <div className="flex flex-1 items-center gap-2 border border-line bg-ink-2 px-3 py-2.5">
                <span className="font-mono text-[15px] text-mute">◈</span>
                <span className="w-full font-mono text-[20px] tabular-nums text-cream">25</span>
                <span className="font-mono text-[12px] uppercase tracking-[0.14em] text-mute">CHIP</span>
              </div>
              <span className="flex h-11 w-11 items-center justify-center rounded-sm border border-line font-mono text-[24px] leading-none text-mute">+</span>
            </div>
            <div
              className={[
                "mt-3.5 w-full rounded-sm border px-3 py-3.5 text-center font-mono text-[15px] uppercase tracking-[0.14em] transition-colors",
                picked ? "border-gilt bg-gilt/[0.06] text-gilt" : "border-line text-mute",
              ].join(" ")}
            >
              {picked ? "Predict ◈25 → win ◈61" : "Pick an outcome to predict"}
            </div>
            <AnimatePresence>
              {picked && (
                <motion.div
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.5 }}
                  className="mt-2.5 text-center font-mono text-[13px] tracking-[0.08em] text-acquit"
                >
                  ✓ Confirmed · 0x9f…c2a ↗
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* a second, collapsed market for context */}
      <div className="mt-3 flex items-center justify-between border border-gilt/40 px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-[14px] uppercase tracking-[0.14em] text-cream">Night 2 kill</div>
          <div className="mt-1 font-mono text-[12.5px] tracking-[0.06em] text-mute">pot ◈96 · fav CATO ×2.1</div>
        </div>
        <span className="rounded-sm border border-gilt/40 px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-gilt">open</span>
      </div>
    </aside>
  );

  return (
    <main className="flex h-full w-full flex-col px-4 pb-4 pt-3">
      {/* the masthead, as context */}
      <header className="flex shrink-0 items-center gap-3 border-b hairline pb-2.5 pt-1">
        <span ref={register("back")} className="flex h-8 items-center rounded-sm px-1 font-mono text-[22px] leading-none text-mute">
          ‹
        </span>
        <span className="font-display text-[20px] font-semibold uppercase leading-none tracking-[0.3em] text-gilt">Turing Pits</span>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-convict">
          <span className="h-1.5 w-1.5 rounded-full bg-convict animate-livepulse" />
          Live
        </span>
        <span className="ml-3 font-mono text-[11px] uppercase tracking-[0.18em] text-gilt">Day 2 · deliberation</span>
        <span className="ml-auto flex h-8 items-center gap-2 rounded-full border border-line-2 bg-ink-2 px-3 font-mono text-[11px] text-cream">
          <span className="h-1.5 w-1.5 rounded-full bg-acquit" />
          225.00 CHIP
        </span>
      </header>

      {wide ? (
        <div className="mt-3 grid min-h-0 flex-1 grid-cols-[200px_minmax(0,1fr)_clamp(360px,36vw,520px)] gap-3">
          {bench}
          {court}
          {wagers}
        </div>
      ) : (
        <div className="mt-3 flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <div className="h-[170px] shrink-0">{bench}</div>
          <div className="min-h-0 flex-1">{court}</div>
          <div className="max-h-[52%] shrink-0 overflow-hidden">{wagers}</div>
        </div>
      )}

      {/* the winnings tray, mirroring the real ClaimTray */}
      <AnimatePresence>
        {showTray && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center px-4"
          >
            <div
              ref={register("tray")}
              className="panel flex items-center gap-4 rounded-sm border border-acquit/50 px-5 py-3 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
            >
              <div>
                <div className="eyebrow text-acquit">Winnings to collect</div>
                <div className="mt-0.5 font-display text-[20px] tracking-[0.04em] text-cream">
                  ◈ 61.00 <span className="font-mono text-[12px] tracking-[0.1em] text-mute">CHIP · 1 market</span>
                </div>
              </div>
              <span className="rounded-sm border border-acquit px-4 py-2.5 font-mono text-[12px] uppercase tracking-[0.14em] text-acquit">
                Collect all
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
  );
}

function MockChoice({
  label,
  eyebrow,
  color,
  pctText,
  mult,
  picked,
}: {
  label: string;
  eyebrow: string;
  color: string;
  pctText: string;
  mult: string;
  picked: boolean;
}) {
  const pctNum = parseInt(pctText, 10) || 0;
  return (
    <div className={["relative border px-3.5 py-3", picked ? "border-gilt bg-gilt/[0.06]" : "border-line-2"].join(" ")}>
      {picked && (
        <span className="absolute -right-px -top-px bg-gilt px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.12em] text-ink">✓ Picked</span>
      )}
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate font-mono text-[12px] uppercase tracking-[0.14em]" style={{ color }}>
          {eyebrow}
        </span>
        <span className="shrink-0 font-mono text-[18px] tabular-nums text-cream">{mult}</span>
      </div>
      <div className="mt-1.5 font-display text-[27px] tracking-[0.1em]" style={{ color }}>
        {label}
      </div>
      <div className="mt-2.5 flex items-baseline justify-between font-mono text-[13px] tracking-[0.06em] text-mute">
        <span>{pctText}</span>
      </div>
      <div className="mt-2 h-[3px] bg-line">
        <div className="h-full" style={{ width: `${pctNum}%`, background: color }} />
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
