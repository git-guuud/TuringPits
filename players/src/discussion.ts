import { createHash } from "node:crypto";
import type { Persona } from "./types.js";

/**
 * How many times a single seat may speak in one day's discussion floor. Keeps a two-seat spat from
 * monopolizing the budget: a seat gets its opening line plus at most one rebuttal, after which the
 * floor must move to someone else (or end). A pure orchestration cap — the moderator still validates
 * every signed vote, so this never touches the rules.
 */
export const MAX_SPEECHES_PER_SEAT = 2;

/**
 * Total lines a day's discussion floor may run before the vote. OFF by default (undefined) → the floor
 * defaults to one line per living seat (the same length as the old fixed parade, but reactively ordered
 * so it reads like an argument instead of a roll-call). Set DISCUSSION_MAX_SPEECHES ABOVE the living
 * count to allow rebuttals (A→B→A back-and-forth); set it BELOW to run a shorter subset where only the
 * seats pulled into the argument speak. Env-tunable, mirroring SPEECH_MAX_WORDS.
 */
export const DISCUSSION_MAX_SPEECHES = ((): number | undefined => {
  const raw = process.env.DISCUSSION_MAX_SPEECHES;
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
})();

/** A seat's name matched as a whole word, case-insensitive (regex-escaped so a "." in a name is literal). */
function nameRegex(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
}

/**
 * The living, non-speaker seats a line NAMES — i.e. who was just invoked and now has a natural right
 * to answer. Derived purely from the public line text against the roster names, so it carries no hidden
 * information: being talked about is a fact the whole table can see. A seat never "names itself" into a
 * reply (the speaker is excluded), so the last speaker is never immediately picked again.
 */
function seatsNamedIn(
  text: string,
  speaker: number,
  alive: readonly number[],
  personas: readonly Persona[],
): number[] {
  return alive.filter((s) => {
    if (s === speaker) return false;
    const p = personas.find((x) => x.seat === s);
    return p ? nameRegex(p.name).test(text) : false;
  });
}

/** Deterministic per-(seed, round, seat) key so ties break reproducibly and not always toward low seats. */
function seatKey(seed: string, round: number, seat: number): string {
  return createHash("sha256").update(`${seed}:discussion:${round}:${seat}`).digest("hex");
}

/** The seeded-first seat of a candidate list (stable for a fixed seed+round, reshuffled each round). */
function pickSeeded(cands: readonly number[], seed: string, round: number): number {
  return [...cands].sort((a, b) => (seatKey(seed, round, a) < seatKey(seed, round, b) ? -1 : 1))[0]!;
}

export interface NextSpeakerInput {
  /** Living seat indices (public). */
  readonly alive: readonly number[];
  /** Every seat's persona, for matching names in the transcript (public). */
  readonly personas: readonly Persona[];
  /** The public speech log so far, `[seat, text]` — only the last line drives right-of-reply. */
  readonly transcript: readonly (readonly [number, string])[];
  /** How many times each seat has already spoken THIS round. */
  readonly spoken: ReadonlyMap<number, number>;
  /** Match seed — the sole source of tie-break order (deterministic, un-gameable). */
  readonly seed: string;
  /** 1-based day round (scopes the deterministic ordering + the per-round spoken counts). */
  readonly round: number;
}

/**
 * Choose who speaks NEXT on the day's discussion floor, or `null` when the floor should close.
 *
 * The rule is a pure function of PUBLIC state — the transcript, the living set, the seed — and NEVER of
 * hidden roles. That is a hard integrity requirement, not a convenience: if turn order keyed off private
 * knowledge (the Detective always speaking right after it investigated, the Doctor always last), the
 * ORDER itself would be a role tell, leaking exactly what the redaction pipeline protects. So selection
 * reads only what the whole table can see; each seat's own private knowledge still shapes what it SAYS
 * (via its prompt context), never when it is called.
 *
 * Priority, recomputed after every line so the floor reacts to what was actually just said:
 *   1. RIGHT-OF-REPLY (unspoken): whoever the last line named and who hasn't spoken yet — the accused
 *      answers immediately, which is what makes the floor read like a real argument, not a parade.
 *   2. FILL: any seat who hasn't spoken this round, in seeded order — every voice gets in before anyone
 *      gets a second turn, and the opener isn't always the lowest seat.
 *   3. REBUTTAL: once everyone has spoken, a named seat still under its per-seat cap answers back
 *      (A→B→A). Only reachable when the caller's line budget exceeds the living count.
 * The caller's line budget and {@link MAX_SPEECHES_PER_SEAT} bound the floor so it can never stretch.
 */
export function nextSpeaker(input: NextSpeakerInput): number | null {
  const { alive, personas, transcript, spoken, seed, round } = input;
  const countOf = (s: number): number => spoken.get(s) ?? 0;

  const last = transcript[transcript.length - 1];
  const named = last ? seatsNamedIn(last[1], last[0], alive, personas) : [];

  // 1. The named-but-unspoken seat replies to the accusation right away.
  const replyUnspoken = named.filter((s) => countOf(s) === 0);
  if (replyUnspoken.length > 0) return pickSeeded(replyUnspoken, seed, round);

  // 2. Everyone gets a first turn before anyone gets a second.
  const unspoken = alive.filter((s) => countOf(s) === 0);
  if (unspoken.length > 0) return pickSeeded(unspoken, seed, round);

  // 3. Rebuttal: a named seat still under its cap answers back (only when the budget allows a 2nd round).
  const rebuttal = named.filter((s) => countOf(s) < MAX_SPEECHES_PER_SEAT);
  if (rebuttal.length > 0) return pickSeeded(rebuttal, seed, round);

  return null;
}
