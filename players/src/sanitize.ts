import type { InferenceProvider, SamplingOptions } from "./types.js";

/**
 * Markers that must never appear in DAY public speech. They are the recurring hallucinations of
 * the weak model: night-phase confusion ("tonight"/"last night"), the "silence = guilt" trope
 * (treating a seat that has not reached its turn as suspicious), and invented behavioural traits.
 * The public speech is explicitly NON-load-bearing — only the structured decision is signed and
 * settled — so the moderator may scrub it. The signed decision is never touched.
 */
export const BAD_SPEECH =
  /\btonight\b|\blast night\b|\bsilen(?:t|ce)\b|\bwithdrawn\b|defensive stance|\bevasive\b|night behavio|lack of (?:involvement|participation|engagement|interaction|communication|activity|contribution)|\b(?:hasn'?t|haven'?t|hadn'?t|isn'?t|aren'?t|not|never|barely|hardly)\s+(?:\w+\s+){0,2}?(?:spoken|speaking|said anything|interact|contribut|participat|engag)/i;

/**
 * CJK / Japanese / Korean script. The Chinese-trained weak model code-switches mid-sentence
 * (e.g. "昨晚的投票结果" — "last night's voting results"), which both breaks the English table AND
 * smuggles past the English-only night-confusion guard above. Curly quotes/dashes (U+2018–2027)
 * are deliberately NOT matched — the model uses them legitimately.
 */
export const NON_ENGLISH =
  /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** True if the text contains any CJK/Japanese/Korean character (a code-switch contamination). */
export function hasNonEnglish(text: string): boolean {
  return NON_ENGLISH.test(text);
}

/** True if the text contains any hallucination marker that should keep it out of the transcript. */
export function hasBadMarker(text: string): boolean {
  return BAD_SPEECH.test(text) || NON_ENGLISH.test(text);
}

/**
 * Names that the weak model invented behaviour for: a roster name the speech references that is NOT
 * in `allowed` (the players who have actually spoken, plus the speaker and any vote target). Players
 * speak in turn, so attributing words/reads to a seat that has not reached its turn is pure
 * fabrication — the single most damaging hallucination, because a false claim about a silent player
 * cascades through the whole table. Returns the forbidden names found (empty = clean).
 */
export function forbiddenNames(
  text: string,
  roster: readonly string[],
  allowed: readonly string[],
): string[] {
  if (roster.length === 0) return [];
  const ok = new Set(allowed.map((n) => n.toLowerCase()));
  return roster.filter((name) => {
    if (ok.has(name.toLowerCase())) return false;
    return new RegExp(`\\b${escapeRe(name)}\\b`, "i").test(text);
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Strip transcript-format contamination from one player's speech. The weak model mimics the
 * `Name: text` transcript layout — it prefixes its own line with a speaker label and sometimes
 * scripts several speakers in one turn. Given the roster `names`, this removes a leading
 * `Name:` / `seat N:` label and truncates at the first point another speaker label begins, so
 * only this player's single utterance remains.
 */
/** Replace every "seat N" reference with that seat's roster name, so output uses names not numbers. */
export function namifySeats(text: string, roster: readonly { seat: number; name: string }[]): string {
  if (!roster || roster.length === 0) return text;
  return text.replace(/seats?\s*#?(\d+)/gi, (m, n) => {
    const p = roster.find((r) => r.seat === Number(n));
    return p ? p.name : m;
  });
}

export function stripSpeakerLabels(text: string, names: readonly string[]): string {
  const labels = [...names.map(escapeRe), "seat\\s*\\d+"].join("|");
  let t = text.trim();
  if (!labels) return t;
  // Cut at the first NEWLINE that introduces another "Name:" line (a scripted second speaker).
  const cut = t.search(new RegExp(`\\n+\\s*(?:${labels})\\s*:`, "i"));
  if (cut !== -1) t = t.slice(0, cut).trim();
  // Remove a single leading "Name:" label on this player's own line.
  t = t.replace(new RegExp(`^\\s*(?:${labels})\\s*:\\s*`, "i"), "").trim();
  // Drop a trailing dangling header the model appends as a fresh transcript line (e.g. it ends its
  // turn with "Today's vote:" and nothing after). Only a SEPARATE final line (preceded by a
  // newline), short, and ending in a colon with no sentence content — never touches inline text.
  t = t.replace(/\n\s*[^\n.!?]{0,40}:\s*$/, "").trim();
  return t;
}

/**
 * Extra markers for NIGHT private reasoning: on round 1 (and any night before real discussion) a
 * player cannot have observed anyone, yet the weak model invents reads like "most confident",
 * "made bold claims", or "accuses loudly". These join {@link BAD_SPEECH} for the night guard.
 */
const NIGHT_INVENTED =
  /most confident|bold claims?|made bold|tendency to accuse|accus\w*\s+(?:others|people|everyone)|speaks?\s+loudly|\bloudly\b|\bassertive\b|\bvocal\b/i;

/**
 * Clean one NIGHT action's private reasoning. Night reasoning is private spectacle/audit text (the
 * binding part is the chosen target), so when it invents behaviour no one could have seen it is
 * replaced with an honest, role-appropriate line about the chosen player. Grounded reasoning that
 * references real prior-day talk has no markers and passes through unchanged.
 */
export function cleanNightReason(raw: string, action: string, targetName: string): string {
  const text = raw.trim();
  if (text && !BAD_SPEECH.test(text) && !NIGHT_INVENTED.test(text) && !NON_ENGLISH.test(text)) return text;
  switch (action) {
    case "kill":
      return `${targetName} looks like a strong early threat, so we remove them.`;
    case "save":
      return `Protecting ${targetName}, a plausible target for the Mafia.`;
    case "investigate":
      return `Investigating ${targetName} to start gathering information.`;
    default:
      return `Choosing ${targetName}.`;
  }
}

const tokens = (s: string): string[] => s.toLowerCase().match(/[a-z0-9']+/g) ?? [];
const sentences = (s: string): string[] =>
  s.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * True if `text` parrots any line in `prior`. Two checks catch the greedy model's echoing:
 *  - whole-text word-set Jaccard ≥ `whole` (a full near-verbatim copy), and
 *  - any sentence (≥7 words) that near-duplicates a prior sentence at Jaccard ≥ `sentence` — this
 *    catches an echo *embedded* in a longer reply, where the whole-text overlap is diluted.
 * Short texts/sentences are skipped so terse one-liners do not trip it.
 *
 * Thresholds are deliberately HIGH: this weak model phrases generic reads ("thin read, voting
 * provisionally") similarly across seats, and once a canned fallback enters the transcript, an
 * over-eager echo check rejects every later genuine-but-generic line and cascades the whole table
 * into canned fallbacks. Only near-verbatim copies should trip it, not shared generic vocabulary.
 */
export function isEcho(text: string, prior: readonly string[], whole = 0.7, sentence = 0.85): boolean {
  const w = new Set(tokens(text));
  if (w.size >= 5) {
    for (const p of prior) {
      if (new Set(tokens(p)).size >= 5 && jaccard(w, new Set(tokens(p))) >= whole) return true;
    }
  }
  const priorSents = prior.flatMap(sentences).map((s) => tokens(s)).filter((t) => t.length >= 7);
  for (const a of sentences(text)) {
    const wa = tokens(a);
    if (wa.length < 7) continue;
    const sa = new Set(wa);
    for (const tb of priorSents) {
      if (jaccard(sa, new Set(tb)) >= sentence) return true;
    }
  }
  return false;
}

/** Correction appended when regenerating a rejected speech for a hallucination marker. */
const MARKER_NOTE =
  "Your previous reply was REJECTED: it treated the unobservable night, or a player simply not " +
  "having spoken yet, as if it were evidence. It is daytime, and players speak in turn — a player " +
  "who has not spoken yet is just waiting their turn, which is normal and never suspicious. Rewrite " +
  'WITHOUT the words "tonight", "silent", or "silence", and without any claim about who has or has ' +
  "not spoken. Ground it only in words a player actually said above.";

/** Correction appended when a speech contained non-English (CJK) text. */
const LANGUAGE_NOTE =
  "Your previous reply was REJECTED because it was not fully in English. Write your ENTIRE reply in English.";

/** Correction appended when regenerating a speech that parroted another player. */
const ECHO_NOTE =
  "Your previous reply was REJECTED for repeating what another player already said. Do NOT echo or " +
  "lightly reword anyone else's line — make a genuinely DIFFERENT point in your own words, or briefly " +
  "say you have nothing new to add yet.";

/** Correction appended when a speech invented behaviour for a player who has not spoken yet. */
const fabricationNote = (names: readonly string[]): string =>
  `Your previous reply was REJECTED: it referred to ${names.join(" and ")}, who ${
    names.length > 1 ? "have" : "has"
  } NOT spoken yet, so you cannot know anything about ${names.length > 1 ? "them" : "them"}. ` +
  "Players speak in turn. Rewrite WITHOUT mentioning anyone who has not spoken above — react only to " +
  "players whose own lines actually appear in the discussion, or make a general point that names no one.";

/**
 * Moderator guard for one unsigned DAY speech. Returns the speech trimmed/label-stripped if it is
 * clean (no hallucination marker AND not a parroted echo of an earlier line). Otherwise it is
 * regenerated ONCE with a correction naming exactly what was wrong; if that still fails (or the
 * call throws), the caller's safe, seat-specific `fallback` is used. This keeps both hallucinations
 * and verbatim echoing out of the public transcript. The signed decision is produced separately and
 * is never affected.
 */
export async function cleanDaySpeech(
  provider: InferenceProvider,
  basePrompt: string,
  rawText: string,
  fallback: string,
  names: readonly string[] = [],
  priorTexts: readonly string[] = [],
  opts?: SamplingOptions,
  allowedNames: readonly string[] = [],
): Promise<string> {
  const clean = (t: string): string => stripSpeakerLabels(t, names);
  const note = (t: string): string => {
    const parts: string[] = [];
    if (hasNonEnglish(t)) parts.push(LANGUAGE_NOTE);
    else if (hasBadMarker(t)) parts.push(MARKER_NOTE); // language note already covers a CJK reject
    if (isEcho(t, priorTexts)) parts.push(ECHO_NOTE);
    // Only enforce the forbidden-name check when an allow-list is supplied; with none, every name
    // is permitted (back-compat for callers that don't track who has spoken).
    if (allowedNames.length > 0) {
      const bad = forbiddenNames(t, names, allowedNames);
      if (bad.length > 0) parts.push(fabricationNote(bad));
    }
    return parts.join(" ");
  };
  const first = clean(rawText);
  const firstNote = note(first);
  if (firstNote === "") return first;
  try {
    const retry = await provider.complete(`${basePrompt}\n\n${firstNote}`, opts);
    const retried = clean(retry.text);
    if (note(retried) === "") return retried;
  } catch {
    // fall through to the safe fallback
  }
  return fallback;
}
