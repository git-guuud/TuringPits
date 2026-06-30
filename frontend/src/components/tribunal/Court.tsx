import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { CATCHUP_THRESHOLD, type ViewState } from "../../state/matchStore.js";
import { useTypewriter } from "../../lib/useTypewriter.js";
import { bodyFall, dayBreak, gavel, loseSting, nightFall, winSting } from "../../lib/typeSound.js";
import type { VoiceApi } from "../../lib/useVoice.js";
import { Testimony } from "./Testimony.js";
import { liveness } from "./Masthead.js";

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
  const caretRef = useRef<HTMLSpanElement>(null);
  // Follow the typing cursor: keep the just-revealed character in view so a long speech scrolls itself
  // as it types instead of running off the bottom of the panel. `block: "nearest"` only nudges the
  // scroll when the caret actually leaves the viewport, so it sits still while the line is visible.
  useEffect(() => {
    if (!done) caretRef.current?.scrollIntoView({ block: "nearest" });
  }, [count, done]);
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
            ref={boundary ? caretRef : undefined}
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

export function Court({
  s,
  advance,
  stepBack,
  skipToPresent,
  voice,
  phaseLabel,
  onOpenRecord,
}: {
  s: ViewState;
  advance: () => void;
  stepBack: () => void;
  skipToPresent: () => void;
  voice: VoiceApi;
  /** The phase tag (e.g. "Day · round 2"), shown top-right above the transcript button on desktop —
   *  the narrow layout carries it in its own header instead, so it's omitted there. */
  phaseLabel?: string;
  /** When provided (desktop), the live/record status pill rides the bottom bar at the left and opens
   *  the record on click. Omitted on narrow, where the mobile header already carries both. */
  onOpenRecord?: () => void;
}) {
  const scene = sceneFor(s);
  // The live/record status for the bottom bar — only when this layout owns it (desktop).
  const recordLive = onOpenRecord ? liveness(s) : null;
  // The stage paces each beat (seconds on screen) while the server emits them ~1/s, so the viewer
  // steadily falls behind "live" — and a late joiner replays from the very start. When the backlog
  // is meaningful, offer a prominent jump straight to the newest beat. Hidden once the record is
  // closed (playbackComplete) — there's nothing further to skip to.
  const behindLive = !s.playbackComplete && s.pendingBeats >= CATCHUP_THRESHOLD;
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
  const [showLog, setShowLog] = useState(false);
  // Playback transport: when paused, the auto-advance below stands down so the current beat holds on
  // the stage. Stepping a beat at a time (back/forward) pauses too, so the show never runs off while
  // a spectator re-reads. Controls show whenever a beat is on stage (cursor ≥ 0).
  const [paused, setPaused] = useState(false);
  const canBack = s.playbackComplete || s.cursor > 0;
  const canForward = s.cursor < s.beats.length - 1 || (!s.playbackComplete && !!s.rawReveal);
  const stepTo = (move: () => void) => {
    setPaused(true);
    move();
  };

  // Playback pacing: once a beat finishes typing, hold a moment, then advance the cursor to the
  // next beat — so nothing is ever cut off, even when the server (or a buffer replay) delivers
  // beats faster than they can be read. Only runs while a beat is actually on the stage, and never
  // while paused (the viewer is holding to re-read).
  useEffect(() => {
    if (paused || !done || !s.currentBeat || s.reveal) return;
    const atLast = s.cursor >= s.beats.length - 1;
    if (atLast && !s.rawReveal) return; // last shown beat, match still going → wait for the next
    const t = setTimeout(advance, 4000);
    return () => clearTimeout(t);
  }, [paused, done, s.currentBeat, s.reveal, s.rawReveal, s.cursor, s.beats.length, advance]);

  // Speak the player's line when a day-speech beat reaches the stage, alongside the typewriter. Night,
  // dawn and the verdict are narration — fall silent there. Keyed on the cursor (via a ref guard) so a
  // pause or an unrelated re-render never restarts the current line, but stepping to a new beat does.
  const { speak: voiceSpeak, stop: voiceStop, available: voiceAvailable } = voice;
  const lastVoiceCursor = useRef(-2);
  useEffect(() => {
    if (!voiceAvailable) return;
    if (lastVoiceCursor.current === s.cursor && !s.playbackComplete) return;
    lastVoiceCursor.current = s.cursor;
    const persona = (seat: number) => s.personas.find((p) => p.seat === seat);
    const nameOf = (seat: number) => persona(seat)?.name ?? `Seat ${seat}`;
    const b = s.currentBeat;
    if (s.playbackComplete || !b) {
      voiceStop();
    } else if (b.kind === "discussion") {
      voiceSpeak({ text: b.speech, name: nameOf(b.seat), blurb: persona(b.seat)?.blurb, kind: "discussion" });
    } else if (b.kind === "turn") {
      const d = b.turn.decision;
      voiceSpeak({
        text: b.turn.speech,
        name: nameOf(b.turn.seat),
        blurb: persona(b.turn.seat)?.blurb,
        kind: "vote",
        targetName: d.action === "vote" ? nameOf(d.target) : null,
      });
    } else {
      voiceStop(); // night / dawn narration
    }
  }, [s.cursor, s.playbackComplete, s.currentBeat, s.personas, voiceAvailable, voiceSpeak, voiceStop]);

  // ── Dramatic SFX ──────────────────────────────────────────────────────────────────────────────
  // Procedural stings punctuate the key beats (shares the typewriter's per-user mute + autoplay
  // guard, so a muted spectator hears none of this and nothing fires before the context is unlocked).
  // Each effect fires ONLY on a genuine transition — a ref carries the prior value so a re-render or a
  // playback pause never re-triggers it; stepping back out of a beat re-arms it.

  // Dusk / dawn sting on the lamp swing. Only during live play — the verdict/settle scenes (also
  // "day"-lit) get the gavel instead, so a match ending at night doesn't pile a dawn chime onto it.
  const lampRef = useRef<"day" | "night" | null>(null);
  useEffect(() => {
    const prev = lampRef.current;
    lampRef.current = scene.lamp;
    if (prev === null || prev === scene.lamp || s.reveal || s.playbackComplete) return;
    if (scene.lamp === "night") nightFall();
    else dayBreak();
  }, [scene.lamp, s.reveal, s.playbackComplete]);

  // A heavy thud whenever a seat newly falls — fires as the death becomes visible on stage, whether
  // it's a night kill surfaced at dawn or a day-vote elimination. Keyed on the rendered alive count.
  const aliveRef = useRef<number | null>(null);
  useEffect(() => {
    const alive = s.seats.reduce((n, x) => n + (x.alive ? 1 : 0), 0);
    const prev = aliveRef.current;
    aliveRef.current = alive;
    if (prev !== null && alive < prev) bodyFall();
  }, [s.seats]);

  // The gavel falls with the verdict — the masks come off (reveal shown once playback completes).
  const gaveledRef = useRef(false);
  useEffect(() => {
    if (s.reveal && !gaveledRef.current) {
      gaveledRef.current = true;
      gavel();
    } else if (!s.reveal) {
      gaveledRef.current = false; // re-arm if the viewer steps back out of the verdict
    }
  }, [s.reveal]);

  // A win/lose cue once the market settles on-chain — keyed to the spectator's own wager on the main
  // market. A refund (Draw/Void) or no stake gets no cue; the gavel already marked the verdict.
  const settledRef = useRef(false);
  useEffect(() => {
    const settled = s.market.state === "SETTLED" && s.playbackComplete;
    if (settled && !settledRef.current) {
      settledRef.current = true;
      const o = s.market.outcome;
      const yes = parseFloat(s.stakes.yes) || 0;
      const no = parseFloat(s.stakes.no) || 0;
      const won = (o === "YES" && yes > 0) || (o === "NO" && no > 0);
      const lost = !won && ((o === "YES" && no > 0) || (o === "NO" && yes > 0));
      if (won) winSting();
      else if (lost) loseSting();
    } else if (!settled) {
      settledRef.current = false;
    }
  }, [s.market.state, s.market.outcome, s.playbackComplete, s.stakes.yes, s.stakes.no]);

  // The aggregate day-vote drama for the stage: how full the count is, who the floor is closing on,
  // and whether the plurality is already locked. Each ALIVE seat casts one vote and the seat with the
  // most is eliminated — a tie at the top spares everyone (engine/src/moderator.ts). Only while a day
  // vote is actually underway (votes cast, match still playing).
  const voteMeter = (() => {
    if (s.phase !== "day" || s.reveal || s.playbackComplete) return null;
    const cast = Object.values(s.votes).reduce((a, b) => a + b, 0);
    if (cast === 0) return null;
    const alive = s.seats.filter((x) => x.alive).length;
    const remaining = Math.max(0, alive - cast);
    const ranked = Object.entries(s.votes)
      .map(([seat, n]) => ({ seat: Number(seat), n }))
      .sort((a, b) => b.n - a.n);
    const lead = ranked[0]!;
    const second = ranked[1]?.n ?? 0;
    const leadName = (s.personas.find((p) => p.seat === lead.seat)?.name ?? `Seat ${lead.seat}`).toUpperCase();
    const tied = ranked.filter((r) => r.n === lead.n).length > 1;
    // Plurality is locked once no rival can catch the leader: their count beats the best any other
    // seat could still reach (current runner-up + every vote not yet cast).
    const condemned = !tied && lead.n > second + remaining;
    // Votes the leader still needs before they can't be caught — the margin to the gallows.
    const toLock = Math.max(0, second + remaining - lead.n + 1);
    return { cast, alive, remaining, leadName, leadVotes: lead.n, tied, condemned, toLock };
  })();

  // Transcript counts day speech — deliberation + votes (night/dawn carry no speech) up to cursor.
  let shownTurns = 0;
  for (let i = 0; i <= s.cursor; i++) {
    const k = s.beats[i]?.kind;
    if (k === "turn" || k === "discussion") shownTurns++;
  }

  return (
    <section className="panel relative flex h-full min-h-0 flex-col overflow-hidden">
      {/* Replaying banner — make it unmistakable the stage is behind live, with one big jump to now. */}
      {behindLive && (
        <button
          type="button"
          onClick={skipToPresent}
          title="Jump past the replay to the latest moment"
          className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-gilt bg-gilt/15 px-6 py-3 font-mono text-[13px] uppercase tracking-[0.22em] text-gilt shadow-[0_0_24px_rgba(240,197,82,0.3)] backdrop-blur-sm transition-colors hover:bg-gilt hover:text-ink"
        >
          <span className="h-2 w-2 animate-livepulse rounded-full bg-gilt" />
          Replaying · {s.pendingBeats} behind
          <span className="text-[15px] tracking-normal">⏭ Skip to present</span>
        </button>
      )}
      {/* The vote board — the aggregate climax of a day vote, so the tensest moment lands on the stage
          itself and not only in the bench's per-seat bars. */}
      {voteMeter && (
        <div className="absolute left-3 top-3 z-30 w-[clamp(150px,42vw,196px)] rounded-sm border border-line-2 bg-[#131009]/90 px-3 py-2.5 backdrop-blur-sm">
          <div className="flex items-baseline justify-between font-mono text-[10px] uppercase tracking-[0.16em] text-mute">
            <span>The vote · R{s.round}</span>
            <span className="tabular-nums text-gilt-soft">
              {voteMeter.cast}/{voteMeter.alive}
            </span>
          </div>
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-line-2">
            <div
              className={["h-full transition-[width] duration-500", voteMeter.condemned ? "bg-convict" : "bg-gilt"].join(" ")}
              style={{ width: `${(voteMeter.cast / Math.max(1, voteMeter.alive)) * 100}%` }}
            />
          </div>
          <div className="mt-2 font-display text-[14px] tracking-[0.07em]">
            {voteMeter.tied ? (
              <span className="text-gilt">Deadlocked — no one falls</span>
            ) : voteMeter.condemned ? (
              <span className="text-convict">{voteMeter.leadName} — condemned</span>
            ) : (
              <span className="text-cream">
                {voteMeter.leadName}
                <span className="ml-1 font-mono text-[12px] text-gilt">·{voteMeter.leadVotes}</span>
              </span>
            )}
          </div>
          {!voteMeter.tied && !voteMeter.condemned && (
            <div className="mt-0.5 font-body text-[11.5px] italic leading-tight text-mute">
              {voteMeter.toLock === 1
                ? "one vote from the gallows"
                : voteMeter.remaining > 0
                  ? `${voteMeter.remaining} still to vote`
                  : "the count holds"}
            </div>
          )}
        </div>
      )}
      {/* Stage control — the phase tag, and the testimony-log toggle stacked beneath it. (Audio toggles
          live in the top panel.) */}
      {(phaseLabel || shownTurns > 0 || showLog) && (
        <div className="absolute right-3 top-3 z-30 flex flex-col items-end gap-2">
          {phaseLabel && (
            <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gilt">{phaseLabel}</span>
          )}
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
      )}
      {showLog && <Testimony s={s} />}
      {/* the banker's lamp — signature element */}
      <motion.div
        aria-hidden
        animate={{ opacity: scene.lamp === "night" ? 0.5 : 1 }}
        transition={{ duration: 1.1 }}
        className="pointer-events-none absolute -top-10 left-1/2 h-[clamp(260px,42vh,420px)] w-[clamp(320px,90vw,560px)] -translate-x-1/2 blur-[2px]"
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

      {/* The stage scrolls inside this inner area; the bottom bar below stays pinned, so long
          dialogue can never carry the controls off-screen. */}
      <div className="relative z-10 flex min-h-0 w-full flex-1 flex-col items-center overflow-y-auto px-5 pt-3.5 pb-3 sm:px-8">
        {/* Centres when short; on a long speech the auto-margins collapse and the block scrolls. */}
        <div className="my-auto flex w-full flex-col items-center py-3">
        <div className="mb-7 mt-1.5 text-center">
          <div className="font-mono text-[14px] uppercase tracking-[0.3em] text-gilt">{scene.title}</div>
          <div className="mt-1.5 font-body text-[18px] italic text-mute">{scene.note}</div>
        </div>

        <motion.h2
          key={scene.name}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center font-display text-[clamp(2rem,7vw,2.875rem)] font-bold leading-none tracking-[0.16em] text-cream sm:tracking-[0.2em]"
          style={{ textShadow: "0 2px 30px rgba(240,197,82,.18)" }}
        >
          {scene.name}
        </motion.h2>
        <div className="mb-7 mt-2.5 text-center font-body text-[18px] italic text-gilt-soft">
          <span className="mx-2 text-mute-2">—</span>
          {scene.role}
          <span className="mx-2 text-mute-2">—</span>
        </div>

        <blockquote className="min-h-[120px] w-full max-w-[34.5rem] text-center font-body text-[clamp(1.25rem,4.6vw,2rem)] italic leading-[1.55] text-cream sm:leading-[1.62]">
          {/* Full text is laid out from the start; characters only fade in — so centered lines
              never slide while typing. */}
          <RevealedSpeech full={scene.body} count={shown.length} done={done} />
        </blockquote>

        {moveLine && (
          <div className="mt-4 min-h-[1.3em] font-mono text-[13px] uppercase tracking-[0.22em] text-gilt">
            {move.shown}
            {!move.done && <span aria-hidden className="ml-0.5 inline-block h-[1em] w-0.5 animate-blink bg-gilt align-middle" />}
          </div>
        )}
        </div>
      </div>

      {/* Pinned bottom bar — the live/record status sits at the left, the playback transport at the
          right. It lives outside the scroll area, so long dialogue never carries the controls off. */}
      {(recordLive || s.cursor >= 0) && (
        <div className="relative z-30 flex shrink-0 items-center justify-between gap-3 px-4 pb-3 pt-1.5">
          {recordLive && onOpenRecord ? (
            <button
              type="button"
              onClick={onOpenRecord}
              title="Open the record"
              className={[
                "flex items-center gap-2 rounded-full border border-line-2 px-3 py-1 font-mono text-[12px] uppercase tracking-[0.2em] transition-colors hover:border-gilt hover:text-cream",
                recordLive.cls,
              ].join(" ")}
            >
              <span className={["h-2 w-2 rounded-full", recordLive.dot, recordLive.pulse ? "animate-livepulse" : ""].join(" ")} />
              {recordLive.label}
            </button>
          ) : (
            <span />
          )}

          {/* Playback transport — pause the auto-advance, or step a beat at a time to re-read a moment
              that scrolled past. Manual steps pause, so the show never runs off while you read. */}
          {s.cursor >= 0 ? (
            <div className="flex items-center gap-1 rounded-full border border-line-2 bg-[#131009]/90 px-1.5 py-1 backdrop-blur-sm">
              <TransportBtn label="Step back a beat" disabled={!canBack} onClick={() => stepTo(stepBack)}>
                ◀
              </TransportBtn>
              <button
                type="button"
                aria-label={paused ? "Resume playback" : "Pause playback"}
                aria-pressed={paused}
                title={paused ? "Play" : "Pause"}
                onClick={() => setPaused((p) => !p)}
                className={[
                  "flex h-7 w-9 items-center justify-center rounded-full border font-mono text-[12px] leading-none transition-colors",
                  paused ? "border-gilt bg-gilt/15 text-gilt" : "border-line-2 text-mute hover:border-gilt hover:text-gilt",
                ].join(" ")}
              >
                {paused ? "▶" : "❚❚"}
              </button>
              <TransportBtn label="Step forward a beat" disabled={!canForward} onClick={() => stepTo(advance)}>
                ▶
              </TransportBtn>
            </div>
          ) : (
            <span />
          )}
        </div>
      )}
    </section>
  );
}

/** One small step/skip button in the stage transport. */
function TransportBtn({
  children,
  label,
  onClick,
  disabled,
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={[
        "flex h-7 w-7 items-center justify-center rounded-full font-mono text-[11px] leading-none transition-colors",
        disabled ? "cursor-not-allowed text-mute-2 opacity-40" : "text-mute hover:text-gilt",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
