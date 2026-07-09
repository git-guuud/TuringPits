import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { CATCHUP_THRESHOLD, type Beat, type ViewState } from "../../state/matchStore.js";
import { useTypewriter } from "../../lib/useTypewriter.js";
import { useCountdown } from "../../lib/useCountdown.js";
import { bodyFall, countdownWarn, dayBreak, gavel, loseSting, marketOpen, nightFall, winSting } from "../../lib/typeSound.js";
import type { VoiceApi } from "../../lib/useVoice.js";
import type { SpeakLine } from "../../lib/voice.js";
import { Testimony } from "./Testimony.js";

const TELLS = ["watching", "Mafia tell"];

// Stage pacing once a beat has finished typing. A spoken beat holds until its audio ends, then a short
// breath (AUDIO_TAIL) before the next speaker; a backstop (AUDIO_MAX_HOLD) advances anyway if a clip
// never signals completion, so a stuck fetch can't freeze the show. Narration / muted playback (no
// audio to wait on) uses a fixed read hold instead.
const NARRATION_HOLD = 4000;
const AUDIO_TAIL = 1200;
const AUDIO_MAX_HOLD = 16000;
// When the stage has fallen behind live (a backlog queued behind the cursor), stop waiting on the full
// audio and drain beats briskly so the gap is self-limiting instead of widening — the "Skip to present"
// banner is already up for an instant jump. Honoring the full clip is reserved for caught-up playback.
const CATCHUP_HOLD = 1200;

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
  /**
   * "speech" = a player is literally talking (their `body` is spoken testimony, rendered in quotes with a
   * SPEAKING marker); "narration" = the court/scene-setting (nightfall, dawn, the book opening, the
   * verdict) rendered as an unquoted inscription. Distinguishing the two is what stops a viewer reading
   * "Night falls…" as something a seat said. Defaults to narration.
   */
  variant?: "speech";
}

function sceneFor(s: ViewState): Scene {
  if (s.market.state === "REFUND")
    return {
      title: "The match is abandoned",
      note: "no result was settled in time",
      name: "MISTRIAL",
      role: "nothing was settled",
      body: "The match ended before a result could be settled. Every prediction is refunded.",
      lamp: "day",
    };
  if (s.market.state === "SETTLED" && s.playbackComplete) {
    return {
      title: "Case closed",
      note: "the result is public",
      name: "CASE CLOSED",
      role: "settled",
      body: "The result is settled, sealed and public. Winners can now claim their payout.",
      lamp: "day",
    };
  }
  if (s.reveal)
    return {
      title: "The masks fall",
      note: "every secret role is now public",
      name: "THE REVEAL",
      role: "the masks come off",
      body:
        s.reveal.winner === "MAFIA"
          ? "The Town was too slow, the Mafia win."
          : "The Town voted out the Mafia, the Town wins.",
      lamp: "day",
    };
  const beat = s.currentBeat;
  if (beat?.kind === "night")
    return {
      title: "Night falls",
      note: "the table sleeps · the Mafia do not",
      name: "NIGHTFALL",
      role: "somewhere, a choice is being made",
      body: "Darkness settles over the table. Somewhere out there the Mafia is picking who dies tonight and the Doctor may be moving to stop them. No one will see a thing until dawn.",
      lamp: "night",
    };
  if (beat?.kind === "dawn") {
    const nameFor = (id: number) => (s.personas.find((p) => p.seat === id)?.name ?? `Seat ${id}`).toUpperCase();
    const names = beat.killed.map(nameFor);
    // Three distinct outcomes: a kill landed, a kill was BLOCKED by a protection (the shielded count,
    // reported anonymously so no role leaks), or the night truly passed with nothing attempted.
    if (names.length > 0)
      return {
        title: "Dawn breaks",
        note: "killed in the night",
        name: names.join(" · "),
        role: "found dead at first light",
        body: `Dawn breaks over the table. ${names.join(" and ")} ${beat.killed.length > 1 ? "were" : "was"} killed in the night. No one saw who did it.`,
        lamp: "day",
      };
    if (beat.saved > 0)
      return {
        title: "Dawn breaks",
        note: "an attack was stopped",
        name: "NO ONE DIED",
        role: "someone was saved in the night",
        body: "Dawn breaks and no one is dead. The Mafia went for a kill but the doctor stopped it. Everyone lives, but the threat is real.",
        lamp: "day",
      };
    return {
      title: "Dawn breaks",
      note: "a quiet night",
      name: "ALL SURVIVE",
      role: "no one died in the night",
      body: "Dawn breaks over the table and everyone is still here. The night passed without a death. The day begins.",
      lamp: "day",
    };
  }
  if (beat?.kind === "claim") {
    const persona = s.personas.find((p) => p.seat === beat.seat);
    // A seat stakes its life on a Detective claim — a momentum swing the table (and the market) must
    // reckon with. Never reveals whether it's true: that is the "real or bluff?" fork bettors take.
    return {
      title: beat.counter ? "A rival claim" : "A bold claim",
      note: beat.counter ? "detective against detective · one is lying" : "a detective claim · real or bluff?",
      name: (persona?.name ?? `Seat ${beat.seat}`).toUpperCase(),
      role: beat.counter ? "also claims to be the Detective" : "steps forward as the Detective",
      body: beat.speech,
      lamp: "day",
      variant: "speech",
    };
  }
  if (beat?.kind === "bet_window") {
    // The stream is paused so a dramatic beat can be a betting beat — the stage frames the question,
    // the Wagers panel takes the money. Copy per market; the on-stage countdown is rendered separately.
    if (beat.market === "NIGHT_KILL")
      return {
        title: "Predictions open",
        note: "predict the Mafia's target",
        name: "WHO DIES TONIGHT?",
        role: "lock in your pick before dawn",
        body: "The Mafia is choosing their target right now. Predict who you think will not survive the night.",
        lamp: "night",
      };
    if (beat.market === "ROUND_VOTED_OUT")
      return {
        title: "Predictions open",
        note: "predict who the table removes",
        name: "WHO GETS VOTED OUT?",
        role: "predict before a single vote is cast",
        body: "The discussion is over and the vote comes next. Predict who the table votes out this round.",
        lamp: "day",
      };
    const name = beat.seat != null ? (s.personas.find((p) => p.seat === beat.seat)?.name ?? `Seat ${beat.seat}`).toUpperCase() : "THE CLAIM";
    return {
      title: "Predictions open",
      note: "a true detective or a bluff?",
      name: "REAL OR BLUFF?",
      role: `${name} claims to be the Detective`,
      body: "A player just claimed to be the Detective. Is it true or a Mafia cover story? Make your prediction before the window closes; the truth comes out at the final reveal.",
      lamp: "day",
    };
  }
  if (beat?.kind === "discussion") {
    const persona = s.personas.find((p) => p.seat === beat.seat);
    return {
      title: "The floor",
      note: "open discussion · before the vote",
      name: (persona?.name ?? `Seat ${beat.seat}`).toUpperCase(),
      role: persona?.blurb ?? "",
      body: beat.speech,
      lamp: "day",
      variant: "speech",
    };
  }
  if (beat?.kind === "turn") {
    const persona = s.personas.find((p) => p.seat === beat.turn.seat);
    return {
      title: "The vote",
      note: "they commit and make their case",
      name: (persona?.name ?? `Seat ${beat.turn.seat}`).toUpperCase(),
      role: persona?.blurb ?? "",
      body: beat.turn.speech,
      lamp: "day",
      variant: "speech",
    };
  }
  if (s.market.state === "LOCKED")
    return {
      title: "Night falls",
      note: "predictions closed at nightfall",
      name: "NIGHTFALL",
      role: "the table holds its breath",
      body: "Predictions are closed. Night falls, and the Mafia make their move in secret.",
      lamp: "night",
    };
  return {
    title: "The match begins",
    note: "predictions open before the first night",
    name: "THE COURT",
    role: "every secret role is sealed",
    body: "The players are seated and every secret role is locked. Make your predictions now, before the first night falls.",
    lamp: "day",
  };
}

export function Court({
  s,
  advance,
  stepBack,
  skipToPresent,
  voice,
}: {
  s: ViewState;
  advance: () => void;
  stepBack: () => void;
  skipToPresent: () => void;
  voice: VoiceApi;
}) {
  const scene = sceneFor(s);
  // A player literally speaking vs the court/scene narrating — drives a distinct on-stage treatment
  // (a SPEAKING marker + quoted, upright testimony vs an unquoted italic inscription) so the two are
  // never mistaken for one another.
  const isSpeech = scene.variant === "speech";
  // The in-loop betting window on stage (if any) — drives the prominent on-stage countdown banner.
  const betWindow = s.betWindow;
  const betCountdown = useCountdown(betWindow?.endsAt ?? null);
  const betClosingSoon = betCountdown != null && betCountdown.ms <= 10000;
  // Pre-match betting hold — a fresh case has convened and betting is open before the first night. On the
  // stage only before any beat lands (cursor < 0), so a new round reads as a deliberate opening, not a flash.
  const preMatchCountdown = useCountdown(s.market.preMatchEndsAt ?? null);
  const showPreMatch = s.cursor < 0 && preMatchCountdown != null;
  // The stage paces each beat (seconds on screen) while the server emits them ~1/s, so the viewer
  // steadily falls behind "live" — and a late joiner replays from the very start. When the backlog
  // is meaningful, offer a prominent jump straight to the newest beat. Hidden once the record is
  // closed (playbackComplete) — there's nothing further to skip to.
  const behindLive = !s.playbackComplete && s.pendingBeats >= CATCHUP_THRESHOLD;
  // The structured move behind the current speech (a day vote names its target).
  const moveLine = (() => {
    const b = s.currentBeat;
    // Belongs to a turn beat's speech only. Once the verdict / sentence / mistrial takes the stage
    // (playback complete, or the court dissolved), the cursor still sits on the last vote beat — suppress
    // the line so that vote's "votes to convict X" can't linger under the final judgement, where there is
    // no vote to report.
    if (s.playbackComplete || s.market.state === "REFUND") return null;
    if (b?.kind !== "turn" || b.turn.decision.action !== "vote") return null;
    const target = b.turn.decision.target;
    const name = (s.personas.find((p) => p.seat === target)?.name ?? `Seat ${target}`).toUpperCase();
    return `▸ votes to convict ${name}`;
  })();
  // A voiced dialogue beat: TTS is available + on AND this beat is spoken (discussion/claim/vote). When
  // true, TTS reads the line aloud — so soften the typewriter clacks (below) so they don't fight the voice,
  // and pace playback to the audio (further down, as `audioExpected`).
  const isSpeechBeat = s.currentBeat?.kind === "discussion" || s.currentBeat?.kind === "claim" || s.currentBeat?.kind === "turn";
  const dialogueVoiced = voice.available && voice.on && !!isSpeechBeat && !s.playbackComplete;
  const clackVolume = dialogueVoiced ? 0.32 : 1; // quieter under TTS; full volume for narration / muted voice
  const { shown, done } = useTypewriter(scene.body, { sound: true, volume: clackVolume });
  // The vote line types out, but only after the speech itself has finished.
  const move = useTypewriter(done && moveLine ? moveLine : "", { sound: true, volume: clackVolume });
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

  // Voice control + the cursor whose spoken line has finished playing (bumped by speak's onEnded, which
  // also fires on mute/synth-failure). The auto-advance below waits on this so a beat is never cut off.
  const { speak: voiceSpeak, stop: voiceStop, prefetch: voicePrefetch, available: voiceAvailable } = voice;
  const [audioDoneCursor, setAudioDoneCursor] = useState(-1);

  // Playback pacing: once a beat finishes typing, hold a moment, then advance the cursor to the
  // next beat — so nothing is ever cut off, even when the server (or a buffer replay) delivers
  // beats faster than they can be read. Only runs while a beat is actually on the stage, and never
  // while paused (the viewer is holding to re-read). When the beat is being voiced, the hold tracks
  // the AUDIO: wait for the spoken line to finish (then a short tail) instead of a fixed timer, so the
  // clip is neither cut off early nor left hanging in silence. Narration / muted playback keeps the
  // fixed read hold. `kind` check (not `lineForBeat`) so this doesn't re-run on every persona change.
  const audioExpected = dialogueVoiced; // same condition as the typewriter-softening above
  useEffect(() => {
    if (paused || !done || !s.currentBeat || s.reveal) return;
    const atLast = s.cursor >= s.beats.length - 1;
    if (atLast && !s.rawReveal) return; // last shown beat, match still going → wait for the next
    // A betting window holds the stage until it closes (endsAt). Live it IS the last beat, so the guard
    // above already parks us here until the server sends the post-window beat; only on a replay (buffer
    // already ahead) do we reach here, where endsAt is in the past → drain promptly to the next beat.
    if (s.currentBeat.kind === "bet_window") {
      const t = setTimeout(advance, Math.max(0, Math.min(s.currentBeat.endsAt - Date.now(), AUDIO_MAX_HOLD)));
      return () => clearTimeout(t);
    }
    // Behind live (a backlog has queued behind the cursor): drain briskly and DON'T wait on the audio,
    // so the trail is self-limiting rather than widening with every long clip. Caught up: a voiced beat
    // still mid-playback holds until its audio ends (a backstop advances anyway if the clip never signals
    // done); once the audio is done — or this is narration / muted — use the tail / read hold. onEnded
    // fires on mute and on synth failure too, so this can't deadlock.
    const behind = s.pendingBeats >= CATCHUP_THRESHOLD;
    const waitingOnAudio = !behind && audioExpected && audioDoneCursor !== s.cursor;
    const hold = waitingOnAudio
      ? AUDIO_MAX_HOLD
      : behind
        ? CATCHUP_HOLD
        : audioExpected
          ? AUDIO_TAIL
          : NARRATION_HOLD;
    const t = setTimeout(advance, hold);
    return () => clearTimeout(t);
  }, [paused, done, s.currentBeat, s.reveal, s.rawReveal, s.cursor, s.beats.length, s.pendingBeats, advance, audioExpected, audioDoneCursor]);

  // Speak the player's line when a day-speech beat reaches the stage, alongside the typewriter. Night,
  // dawn and the verdict are narration — fall silent there. Keyed on the cursor (via a ref guard) so a
  // pause or an unrelated re-render never restarts the current line, but stepping to a new beat does.
  const lastVoiceCursor = useRef(-2);
  // Resolve a beat to the line to voice (null for night/dawn narration) — shared by speak + prefetch.
  const lineForBeat = (b: Beat | null): SpeakLine | null => {
    if (!b) return null;
    const persona = (seat: number) => s.personas.find((p) => p.seat === seat);
    const nameOf = (seat: number) => persona(seat)?.name ?? `Seat ${seat}`;
    if (b.kind === "discussion" || b.kind === "claim")
      return { text: b.speech, name: nameOf(b.seat), blurb: persona(b.seat)?.blurb, kind: "discussion" };
    if (b.kind === "turn") {
      const d = b.turn.decision;
      return {
        text: b.turn.speech,
        name: nameOf(b.turn.seat),
        blurb: persona(b.turn.seat)?.blurb,
        kind: "vote",
        targetName: d.action === "vote" ? nameOf(d.target) : null,
      };
    }
    return null;
  };
  useEffect(() => {
    if (!voiceAvailable) return;
    if (lastVoiceCursor.current === s.cursor && !s.playbackComplete) return;
    const cursorAtCall = s.cursor;
    lastVoiceCursor.current = cursorAtCall;
    const line = lineForBeat(s.currentBeat);
    if (s.playbackComplete || !line) {
      voiceStop();
    } else {
      // onEnded marks this cursor done so the stage can advance the instant the voice finishes.
      voiceSpeak(line, { onEnded: () => setAudioDoneCursor(cursorAtCall) });
    }
    // Warm the next spoken line so it plays instantly when it reaches the stage — this is what closes
    // the "audio starts well after the text" gap (the tag + synth round-trip happens during this beat).
    for (let i = cursorAtCall + 1; i < s.beats.length; i++) {
      const next = lineForBeat(s.beats[i] ?? null);
      if (next) {
        voicePrefetch(next);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cursor, s.playbackComplete, s.currentBeat, s.personas, s.beats, voiceAvailable, voiceSpeak, voiceStop, voicePrefetch]);

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

  // A win/lose cue once the market settles on-chain — keyed to the spectator's own wager on the headline
  // FACTION market. A void (full refund) or no stake gets no cue; the gavel already marked the verdict.
  const settledRef = useRef(false);
  useEffect(() => {
    const settled = s.market.state === "SETTLED" && s.playbackComplete;
    if (settled && !settledRef.current) {
      settledRef.current = true;
      const faction = (s.market.props ?? []).find((p) => p.kind === "FACTION");
      const win = faction?.state === "RESOLVED" ? faction.winningOutcome : undefined;
      if (win != null) {
        const mine = s.propStakes.find((ps) => ps.index === faction!.index);
        const myWin = parseFloat(mine?.stakes[win] ?? "0") || 0;
        const myTotal = mine ? mine.stakes.reduce((a, v) => a + parseFloat(v), 0) : 0;
        if (myWin > 0) winSting();
        else if (myTotal > 0) loseSting();
      }
    } else if (!settled) {
      settledRef.current = false;
    }
  }, [s.market.state, s.market.props, s.playbackComplete, s.propStakes]);

  // A bright market bell when a timed betting window opens on stage. Keyed on the window's identity so a
  // re-render / pause never re-rings it; a new window (or re-entering one after stepping out) re-arms.
  const betWindowKey = betWindow ? `${betWindow.market}-${betWindow.round}-${betWindow.propIndex}` : null;
  const betWindowRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = betWindowRef.current;
    betWindowRef.current = betWindowKey;
    if (betWindowKey && betWindowKey !== prev) marketOpen();
  }, [betWindowKey]);

  // A tense per-second beep through the window's final ten seconds (the timer turns red). We key on the
  // integer second remaining so each second rings exactly once (10, 9, … 1) as the countdown ticks down,
  // re-arming above 10s; a replayed window (which opens already expired, ms clamped to 0 → 0s) stays quiet.
  const lastBeepSecRef = useRef<number | null>(null);
  useEffect(() => {
    const ms = betCountdown?.ms ?? null;
    if (ms == null) {
      lastBeepSecRef.current = null;
      return;
    }
    const sec = Math.ceil(ms / 1000);
    if (sec > 10) {
      lastBeepSecRef.current = null;
    } else if (sec >= 1 && sec !== lastBeepSecRef.current) {
      lastBeepSecRef.current = sec;
      countdownWarn();
    }
  }, [betCountdown]);

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
    if (k === "turn" || k === "discussion" || k === "claim") shownTurns++;
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
      {/* Pre-match banner — a fresh case has convened; betting is open before the first night. The countdown
          lands dead-centre on stage so the new round is unmistakable and holds until the first night falls. */}
      {showPreMatch && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-3 rounded-full border border-gilt bg-gilt/15 px-5 py-2.5 shadow-[0_0_24px_rgba(240,197,82,0.3)] backdrop-blur-sm"
        >
          <span className="h-2 w-2 animate-livepulse rounded-full bg-gilt" />
          <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-gilt">New case · predictions open</span>
          <span className="font-mono text-[17px] tabular-nums tracking-[0.08em] text-cream">{preMatchCountdown!.label}</span>
          <span className="font-mono text-[12px] tracking-normal text-mute">first night falls at zero</span>
        </motion.div>
      )}

      {/* Betting-window pill — the stream is paused for a wager, so a live countdown lands centre-stage.
          Kept compact on purpose: the scene header already names the question and the Wagers panel holds
          the bet, so this stays a slim pulse + countdown rather than a wide label that sprawled under the
          transcript toggle at the top-right. */}
      {betWindow && betCountdown && (
        <motion.div
          key={`${betWindow.market}-${betWindow.round}`}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className={[
            "absolute left-1/2 top-3 z-40 flex -translate-x-1/2 items-center gap-2.5 rounded-full border px-4 py-2 backdrop-blur-sm",
            betClosingSoon ? "border-convict bg-convict/15 shadow-[0_0_24px_rgba(179,58,58,0.3)]" : "border-gilt bg-gilt/15 shadow-[0_0_24px_rgba(240,197,82,0.3)]",
          ].join(" ")}
        >
          <span className={["h-2 w-2 animate-livepulse rounded-full", betClosingSoon ? "bg-convict" : "bg-gilt"].join(" ")} />
          <span className={["font-mono text-[11px] uppercase tracking-[0.2em]", betClosingSoon ? "text-convict" : "text-gilt"].join(" ")}>
            {betClosingSoon ? "Closing" : "Predictions open"}
          </span>
          <span className={["font-mono text-[16px] tabular-nums tracking-[0.06em]", betClosingSoon ? "animate-livepulse text-convict" : "text-cream"].join(" ")}>
            {betCountdown.label}
          </span>
        </motion.div>
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
              <span className="text-gilt">Tied, no one is voted out</span>
            ) : voteMeter.condemned ? (
              <span className="text-convict">{voteMeter.leadName} voted out</span>
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
                ? "one vote from being voted out"
                : voteMeter.remaining > 0
                  ? `${voteMeter.remaining} still to vote`
                  : "the count holds"}
            </div>
          )}
        </div>
      )}
      {/* Stage control — the testimony-log toggle. (Audio toggles + phase/liveness live in the header.)
          Sits above the centred banners (z-40) so a betting-window pill can never cover it. */}
      {(shownTurns > 0 || showLog) && (
        <div className="absolute right-3 top-3 z-40 flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => setShowLog((v) => !v)}
            className="rounded-sm border border-line-2 px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.16em] text-mute transition-colors hover:border-gilt hover:text-gilt"
          >
            {showLog ? "Close ✕" : `Transcript · ${shownTurns}`}
          </button>
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
        <div className="mb-7 mt-1.5 flex flex-col items-center text-center">
          {/* Narration gets a quiet eyebrow so the court's scene-setting reads as narration; a player's own
              words need no label — the quoted, upright body already marks them as speech. */}
          {!isSpeech && (
            <span className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.34em] text-mute-2">
              <span className="mr-2 text-line-2">✦</span>Narration<span className="ml-2 text-line-2">✦</span>
            </span>
          )}
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

        {/* Testimony is rendered as an actual spoken quote — upright, wrapped in gilt quotation marks — so
            it reads as the player's own voice. Narration stays an italic, unquoted inscription. */}
        <blockquote
          className={[
            "min-h-[120px] w-full max-w-[34.5rem] text-center font-body text-[clamp(1.25rem,4.6vw,2rem)] leading-[1.55] text-cream sm:leading-[1.62]",
            isSpeech ? "not-italic" : "italic",
          ].join(" ")}
        >
          {/* Full text is laid out from the start; characters only fade in — so centered lines
              never slide while typing. */}
          {isSpeech && <span aria-hidden className="mr-1 align-[-0.25em] font-display text-[1.5em] leading-[0] text-gilt-soft">“</span>}
          <RevealedSpeech full={scene.body} count={shown.length} done={done} />
          {isSpeech && <span aria-hidden className="ml-1 align-[-0.25em] font-display text-[1.5em] leading-[0] text-gilt-soft">”</span>}
        </blockquote>

        {moveLine && (
          <div className="mt-4 min-h-[1.3em] font-mono text-[13px] uppercase tracking-[0.22em] text-gilt">
            {move.shown}
            {!move.done && <span aria-hidden className="ml-0.5 inline-block h-[1em] w-0.5 animate-blink bg-gilt align-middle" />}
          </div>
        )}
        </div>
      </div>

      {/* Pinned bottom bar — the playback transport, kept to the right. It lives outside the scroll
          area, so long dialogue never carries the controls off-screen. */}
      {s.cursor >= 0 && (
        <div className="relative z-30 flex shrink-0 items-center justify-end gap-3 px-4 pb-3 pt-1.5">
          {/* Playback transport — pause the auto-advance, or step a beat at a time to re-read a moment
              that scrolled past. Manual steps pause, so the show never runs off while you read. */}
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
