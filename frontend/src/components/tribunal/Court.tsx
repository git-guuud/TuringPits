import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { ViewState } from "../../state/matchStore.js";
import { useTypewriter } from "../../lib/useTypewriter.js";
import { getMuted, setMuted } from "../../lib/typeSound.js";
import { Testimony } from "./Testimony.js";

const TELLS = ["watching", "Mafia tell"];

/** Per-character gilt mask for the two recurring tells, without parsing meaning. */
function giltMask(text: string): boolean[] {
  const mask = new Array(text.length).fill(false);
  for (const kw of TELLS) {
    let i = text.indexOf(kw);
    while (i !== -1) {
      for (let j = i; j < i + kw.length; j++) mask[j] = true;
      i = text.indexOf(kw, i + kw.length);
    }
  }
  return mask;
}

/** The blinking caret bar — absolutely positioned, so it never participates in layout. */
function CaretBar({ at }: { at: "left-0" | "left-full" }) {
  return <span aria-hidden className={`absolute ${at} top-[0.18em] h-[1.05em] w-0.5 animate-blink bg-gilt`} />;
}

/**
 * Render the FULL speech immediately (so line layout is final and centered text can't slide), then
 * reveal it by fading characters in left-to-right. `count` chars are shown; the rest occupy their
 * final positions at opacity 0. The caret is drawn out of flow at the boundary char so it adds no
 * width and can't nudge the line as it advances.
 */
function RevealedSpeech({ full, count, done }: { full: string; count: number; done: boolean }) {
  const mask = giltMask(full);
  return (
    <>
      {count === 0 && !done && (
        <span className="relative">
          <CaretBar at="left-0" />
        </span>
      )}
      {full.split("").map((ch, i) => {
        const boundary = !done && i === count - 1;
        return (
          <span
            key={i}
            className={[
              i < count ? "opacity-100" : "opacity-0",
              mask[i] ? "text-gilt" : "",
              boundary ? "relative" : "",
            ].join(" ")}
          >
            {ch}
            {boundary && <CaretBar at="left-full" />}
          </span>
        );
      })}
    </>
  );
}

interface Scene {
  title: string;
  note: string;
  name: string;
  role: string;
  body: string;
  lamp: "day" | "night";
}

function sceneFor(s: ViewState): Scene {
  if (s.market.state === "REFUND")
    return {
      title: "The court is dissolved",
      note: "no verdict was entered in time",
      name: "MISTRIAL",
      role: "the record was never sealed",
      body: "The match was abandoned before a verdict could be settled on-chain. The court is dissolved — every wager may be reclaimed in full.",
      lamp: "day",
    };
  if (s.market.state === "SETTLED" && s.playbackComplete) {
    const o = s.market.outcome;
    if (o === "DRAW")
      return {
        title: "The court rises",
        note: "no verdict could be reached",
        name: "MISTRIAL",
        role: "the bench is hung",
        body: "The court could not reach a verdict — a mistrial is entered into the record. Every wager is returned, less a small fee. The court rises.",
        lamp: "day",
      };
    if (o === "VOID")
      return {
        title: "The court rises",
        note: "a verdict with no wager behind it",
        name: "MARKET VOID",
        role: "no stake backed the verdict",
        body: "A faction prevailed — but no wager was placed on the winning side, so the market is void. Every stake is returned in full. The court rises.",
        lamp: "day",
      };
    return {
      title: "The court rises",
      note: "the record stands, publicly auditable",
      name: "CASE CLOSED",
      role: "entered into evidence",
      body: "The sentence is entered into evidence, sealed and public. The court rises. Winners may claim against the chain.",
      lamp: "day",
    };
  }
  if (s.reveal)
    return {
      title: "The masks fall",
      note: "each role read into the record",
      name: "THE SENTENCE",
      role: "the masks come off",
      body:
        s.reveal.winner === "MAFIA"
          ? "The hidden hand reached parity in the dark. The Town named them too late — the Mafia prevails."
          : "The Town rooted out every hidden hand before parity. The Mafia does not walk — they are convicted.",
      lamp: "day",
    };
  const beat = s.currentBeat;
  if (beat?.kind === "night")
    return {
      title: "Night falls",
      note: "the table sleeps · the hand moves unseen",
      name: "NIGHTFALL",
      role: "the night keeps its counsel",
      body: "Darkness settles over the table. In the dark, the hidden hand makes its choice — and the night keeps its secret. No word is spoken, no hand is named.",
      lamp: "night",
    };
  if (beat?.kind === "dawn") {
    const nameFor = (id: number) => (s.personas.find((p) => p.seat === id)?.name ?? `Seat ${id}`).toUpperCase();
    const names = beat.killed.map(nameFor);
    const fell = beat.killed.length > 0;
    return {
      title: "Dawn breaks",
      note: fell ? "the night's work laid bare" : "the night passes, and holds",
      name: fell ? names.join(" · ") : "ALL SURVIVE",
      role: fell ? "found fallen at first light" : "the hand reached out and missed",
      body: fell
        ? `Dawn breaks over the table. ${names.join(" and ")} ${beat.killed.length > 1 ? "are" : "is"} found fallen — taken in the night, before a word could be spoken in their defence.`
        : "Dawn breaks over the table. Every seat still draws breath — the hand reached out in the dark and found nothing. The court resumes.",
      lamp: "day",
    };
  }
  if (beat?.kind === "discussion") {
    const persona = s.personas.find((p) => p.seat === beat.seat);
    return {
      title: "The floor",
      note: "deliberation · before the vote",
      name: (persona?.name ?? `Seat ${beat.seat}`).toUpperCase(),
      role: persona?.blurb ?? "",
      body: beat.speech,
      lamp: "day",
    };
  }
  if (beat?.kind === "turn") {
    const persona = s.personas.find((p) => p.seat === beat.turn.seat);
    return {
      title: "Sworn testimony",
      note: "the table turns to them",
      name: (persona?.name ?? `Seat ${beat.turn.seat}`).toUpperCase(),
      role: persona?.blurb ?? "",
      body: beat.turn.speech,
      lamp: "day",
    };
  }
  if (s.market.state === "LOCKED")
    return {
      title: "Night falls",
      note: "wagers sealed at nightfall",
      name: "NIGHTFALL",
      role: "the table holds its breath",
      body: "The doors are barred. No further wagers. The hidden hand chooses, and the night keeps its secret.",
      lamp: "night",
    };
  return {
    title: "The court convenes",
    note: "wagers open before testimony begins",
    name: "THE COURT",
    role: "sworn under commitment",
    body: "The seats are sworn. The hidden hand is sealed in the record. Wagers, now, before the first night falls.",
    lamp: "day",
  };
}

export function Court({ s, advance }: { s: ViewState; advance: () => void }) {
  const scene = sceneFor(s);
  // The structured move behind the current speech (a day vote names its target).
  const moveLine = (() => {
    const b = s.currentBeat;
    if (b?.kind !== "turn" || b.turn.decision.action !== "vote") return null;
    const target = b.turn.decision.target;
    const name = (s.personas.find((p) => p.seat === target)?.name ?? `Seat ${target}`).toUpperCase();
    return `▸ votes to convict ${name}`;
  })();
  const { shown, done } = useTypewriter(scene.body, { sound: true });
  // The vote line types out, but only after the speech itself has finished.
  const move = useTypewriter(done && moveLine ? moveLine : "", { sound: true });
  // Attestation provenance only ever shown for a day testimony — night carries no actor.
  const att = s.currentBeat?.kind === "turn" ? s.currentBeat.turn.attestation : null;
  const [showLog, setShowLog] = useState(false);
  const [muted, setMutedState] = useState(getMuted);

  // Playback pacing: once a beat finishes typing, hold a moment, then advance the cursor to the
  // next beat — so nothing is ever cut off, even when the server (or a buffer replay) delivers
  // beats faster than they can be read. Only runs while a beat is actually on the stage.
  useEffect(() => {
    if (!done || !s.currentBeat || s.reveal) return;
    const atLast = s.cursor >= s.beats.length - 1;
    if (atLast && !s.rawReveal) return; // last shown beat, match still going → wait for the next
    const t = setTimeout(advance, 4000);
    return () => clearTimeout(t);
  }, [done, s.currentBeat, s.reveal, s.rawReveal, s.cursor, s.beats.length, advance]);

  // Transcript counts day speech — deliberation + votes (night/dawn carry no speech) up to cursor.
  let shownTurns = 0;
  for (let i = 0; i <= s.cursor; i++) {
    const k = s.beats[i]?.kind;
    if (k === "turn" || k === "discussion") shownTurns++;
  }

  return (
    <section className="panel relative flex min-h-0 flex-col items-center justify-center overflow-y-auto px-8 pb-8 pt-3.5">
      {/* Stage controls — mute the typewriter, and open the testimony log over the stage. */}
      <div className="absolute right-3 top-3 z-30 flex items-center gap-2">
        <button
          type="button"
          aria-label={muted ? "Unmute typewriter sound" : "Mute typewriter sound"}
          aria-pressed={muted}
          onClick={() => {
            const next = !muted;
            setMuted(next);
            setMutedState(next);
          }}
          className="rounded-sm border border-line-2 px-2 py-1 font-mono text-[12px] leading-none text-mute transition-colors hover:border-gilt hover:text-gilt"
        >
          {muted ? "🔇" : "🔊"}
        </button>
        {(shownTurns > 0 || showLog) && (
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-mute transition-colors hover:border-gilt hover:text-gilt"
          >
            {showLog ? "Close ✕" : `Transcript · ${shownTurns}`}
          </button>
        )}
      </div>
      {showLog && <Testimony s={s} />}
      {/* the banker's lamp — signature element */}
      <motion.div
        aria-hidden
        animate={{ opacity: scene.lamp === "night" ? 0.5 : 1 }}
        transition={{ duration: 1.1 }}
        className="pointer-events-none absolute -top-10 left-1/2 h-[420px] w-[560px] -translate-x-1/2 blur-[2px]"
        style={{
          background:
            "radial-gradient(closest-side, rgba(240,197,82,.20), rgba(240,197,82,.06) 45%, transparent 72%)",
        }}
      >
        <span
          className="absolute left-1/2 top-[30px] h-5 w-[13px] -translate-x-1/2 rounded-[50%_50%_48%_48%]"
          style={{
            background: "radial-gradient(circle at 50% 35%, #fff0c0, #f0c552 55%, #9c7c20)",
            boxShadow: "0 0 22px 6px rgba(240,197,82,.5)",
          }}
        />
      </motion.div>

      <div className="relative z-10 mb-7 mt-1.5 text-center">
        <div className="font-mono text-[12px] uppercase tracking-[0.3em] text-gilt">{scene.title}</div>
        <div className="mt-1.5 font-body text-[15px] italic text-mute">{scene.note}</div>
      </div>

      <motion.h2
        key={scene.name}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative z-10 text-center font-display text-[46px] font-bold leading-none tracking-[0.2em] text-cream"
        style={{ textShadow: "0 2px 30px rgba(240,197,82,.18)" }}
      >
        {scene.name}
      </motion.h2>
      <div className="relative z-10 mb-7 mt-2.5 text-center font-body text-[15px] italic text-gilt-soft">
        <span className="mx-2 text-mute-2">—</span>
        {scene.role}
        <span className="mx-2 text-mute-2">—</span>
      </div>

      <blockquote className="relative z-10 min-h-[150px] w-[560px] max-w-full text-center font-body text-[32px] italic leading-[1.62] text-cream">
        {/* Full text is laid out from the start; characters only fade in — so centered lines
            never slide while typing. */}
        <RevealedSpeech full={scene.body} count={shown.length} done={done} />
      </blockquote>

      {moveLine && (
        <div className="relative z-10 mt-4 min-h-[1.3em] font-mono text-[13px] uppercase tracking-[0.22em] text-gilt">
          {move.shown}
          {!move.done && <span aria-hidden className="ml-0.5 inline-block h-[1em] w-0.5 animate-blink bg-gilt align-middle" />}
        </div>
      )}

      {att && (
        <span className="absolute bottom-5 left-1/2 z-20 inline-flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-sm border border-line-2 bg-[#131009] px-3 py-1.5 font-mono text-[11.5px] uppercase tracking-[0.14em] text-mute">
          <span
            className={[
              "h-1.5 w-1.5 rounded-full",
              att.source === "0g-tee" ? "bg-acquit shadow-[0_0_8px_rgba(127,160,126,0.8)]" : "bg-gilt-soft",
            ].join(" ")}
          />
          {att.source === "0g-tee" ? "Sworn & witnessed · 0G attested" : "Local key · MOCK-local"} · {att.signerAddress.slice(0, 6)}…{att.signerAddress.slice(-4)}
        </span>
      )}
    </section>
  );
}
