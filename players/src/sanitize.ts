import type { InferenceProvider, SamplingOptions } from "./types.js";

/**
 * Markers that must never appear in DAY public speech. They are the recurring hallucinations of
 * the weak model: night-phase confusion ("tonight"/"last night"), the "silence = guilt" trope
 * (treating a seat that has not reached its turn as suspicious), and invented behavioural traits.
 * The public speech is explicitly NON-load-bearing — only the structured decision is signed and
 * settled — so the moderator may scrub it. The signed decision is never touched.
 */
export const BAD_SPEECH =
  /\btonight\b|\blast night\b|\bsilen(?:t|ce)\b|\bwithdrawn\b|defensive stance|\bevasive\b|night behavio|night began|(?:since|during|throughout) the night|eye[-\s]?contact|body language|facial expression|\bfidget|\bsquirm|\bshifty\b|\bflinch|\btrembl|\bsweating\b|nervous (?:glance|tic|twitch|gesture)|avoiding (?:eye|eyes|my gaze|our gaze)|\bgaze\b|\bdemean(?:our|or)\b|usual\s+(?:self|behavio(?:u)?r|demean(?:our|or)|manner|temperament|tone)|out of character|(?:hasn'?t|haven'?t|isn'?t|aren'?t|wasn'?t|weren'?t)\s+been\s+(?:him|her|them|it)self|acting\s+(?:\w+ly\s+)?(?:secretive\w*|strange\w*|odd\w*|weird\w*|cagey|defensiv\w*|shady|sketchy|paranoid|guilty|fishy|suspicious\w*|nervous\w*|differe\w*)|\bnervousness\b|nervous around|(?:is|are|was|were|seems?|seemed|look(?:s|ed)?|appears?|appeared|been|gets?|getting|grew|so|very|really|quite|visibly|clearly)\s+(?:nervous|anxious|uneasy|jittery|flustered|rattled|on edge)|lack of (?:involvement|participation|engagement|interaction|communication|activity|contribution)|\b(?:hasn'?t|haven'?t|hadn'?t|isn'?t|aren'?t|not|never|barely|hardly)\s+(?:\w+\s+){0,2}?(?:spoken|speaking|said anything|interact|contribut|participat|engag)/i;

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
 * A first-person claim about one's OWN night action — a real Detective reveal or a Mafia's fake
 * Detective bluff. Such a line may LEGITIMATELY reference the night ("I investigated Boris last
 * night — he's Mafia"), unlike a fabricated observation of someone ELSE at night ("Boris was
 * suspicious last night"), which the night guard rightly rejects. Used to exempt only the night WORD
 * in such a claim — every other fabrication marker still counts.
 */
const OWN_NIGHT_CLAIM =
  /\b(?:I\s+investigated\b|my\s+investigation\b|I(?:'?m| am)\s+the\s+(?:detective|doctor)\b|I\s+checked\b|I\s+looked\s+into\b)/i;

/**
 * Per-sentence bad-marker test used by the salvage and the day guard. Identical to {@link hasBadMarker}
 * EXCEPT that a bare night reference ("last night"/"tonight") inside an {@link OWN_NIGHT_CLAIM} is not
 * counted — so a Detective reveal / Mafia bluff that cites its own night investigation survives instead
 * of being nuked for legitimately naming the night. CJK and all other fabrication markers still count.
 */
export function sentenceHasBadMarker(s: string): boolean {
  if (NON_ENGLISH.test(s)) return true;
  if (!BAD_SPEECH.test(s)) return false;
  if (OWN_NIGHT_CLAIM.test(s) && !BAD_SPEECH.test(s.replace(/\btonight\b|\blast night\b|\bthat night\b/gi, " "))) {
    return false;
  }
  return true;
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
export function cleanNightReason(raw: string, action: string, targetName: string, selfName = ""): string {
  const text = raw.trim();
  // Reject third-person self-narration too: the weak model echoes its own persona blurb in the third
  // person on a self-save ("Felix is the prosecutor… making him a likely target" when the actor IS
  // Felix), which reads as nonsense in the private audit log. The day guard already catches this for
  // public speech; the night reason had no such check, so it leaked. Falls to the role line below.
  const grounded =
    !!text &&
    !BAD_SPEECH.test(text) &&
    !NIGHT_INVENTED.test(text) &&
    !NON_ENGLISH.test(text) &&
    !(selfName !== "" && refersToSelfInThirdPerson(text, selfName));
  if (grounded) return text;
  const isSelf = selfName !== "" && targetName === selfName;
  switch (action) {
    case "kill":
      return `${targetName} looks like a strong early threat, so we remove them.`;
    case "save":
      // A Doctor guarding ITSELF should reason in the first person, not narrate its own name.
      return isSelf
        ? `Guarding myself this round — I am a plausible target for the Mafia.`
        : `Protecting ${targetName}, a plausible target for the Mafia.`;
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

/**
 * Strip a LEADING verbatim echo of an earlier line off this speech. The greedy weak model loves to
 * open its turn by copying the previous speaker's whole sentence(s) and only THEN add its own point
 * (live probe: nearly every rejected round-1 line began with a copy of the opener). Dropping those
 * leading near-duplicate sentences salvages the genuine point that follows, which would otherwise be
 * thrown away whole by the echo check and replaced by a bland fallback. Only LEADING echoes are
 * removed — an echo buried mid-reply is genuine parroting and still trips {@link isEcho}.
 */
export function stripLeadingEcho(text: string, prior: readonly string[]): string {
  if (prior.length === 0) return text;
  const priorSets = prior.flatMap(sentences).map((s) => new Set(tokens(s))).filter((s) => s.size >= 4);
  if (priorSets.length === 0) return text;
  const segs = sentences(text);
  let i = 0;
  while (i < segs.length) {
    const sa = new Set(tokens(segs[i]!));
    if (sa.size >= 4 && priorSets.some((sb) => jaccard(sa, sb) >= 0.8)) i++;
    else break;
  }
  if (i === 0) return text; // no leading echo
  const kept = segs.slice(i).join(" ").trim();
  return kept.length === 0 ? text : kept; // all-echo → leave it for the echo guard to reject
}

/**
 * Drop whole SENTENCES that near-duplicate an EARLIER speaker's sentence, keeping the unique ones —
 * the trailing/embedded counterpart to {@link stripLeadingEcho}. The weak model mode-collapses onto
 * shared stock closers ("Let's unite and vote X out today.", "Let's focus on the facts and make an
 * informed decision together.") that every seat reaches for, so a genuinely unique OPENING gets the
 * whole line rejected for one parroted closing sentence — the single biggest driver of the live regen
 * rate (echo was ~all of a ~33% reject rate). Stripping just the echoed sentence(s) salvages the real
 * point with no regeneration call. Mirrors {@link stripMarkedSentences}: returns the original when
 * nothing is dropped or too little would remain (then the echo guard rejects→regenerates). The
 * threshold matches {@link isEcho}'s sentence check, so it removes exactly what would otherwise trip.
 */
export function stripEchoedSentences(text: string, prior: readonly string[], sentence = 0.85): string {
  const segs = sentences(text);
  if (segs.length <= 1) return text; // a single sentence is all-or-nothing — leave it for the echo guard
  const priorSents = prior
    .flatMap(sentences)
    .map((s) => tokens(s))
    .filter((t) => t.length >= 7)
    .map((t) => new Set(t));
  if (priorSents.length === 0) return text;
  const kept = segs.filter((s) => {
    const t = tokens(s);
    if (t.length < 7) return true; // too short to be a meaningful echo — keep
    const st = new Set(t);
    return !priorSents.some((p) => jaccard(st, p) >= sentence);
  });
  if (kept.length === segs.length) return text; // nothing dropped
  const out = kept.join(" ").trim();
  return tokens(out).length >= 5 ? out : text; // too little left → let the echo guard reject→regenerate
}

/**
 * Drop whole SENTENCES that name a player OUTSIDE the allow-list — a seat that has died (so it can no
 * longer be voted or meaningfully re-litigated), keeping the clean ones. The weak model fixates on a
 * player who was prominent in the recent transcript and keeps re-accusing them AFTER they are killed
 * (live: the most-discussed seat died on night 1 and the next day's lines kept pushing the vote onto
 * the corpse). Such a line was rejected WHOLE → a regeneration call, then often a canned fallback;
 * salvaging just the clean sentences keeps the genuine point and removes a regeneration. Mirrors
 * {@link stripMarkedSentences} / {@link stripEchoedSentences}: a no-op when no allow-list is supplied
 * (back-compat), when a single sentence is all-or-nothing, when nothing is dropped, or when too little
 * would remain (then the forbidden-name guard rejects→regenerates as before).
 */
export function stripForbiddenNameSentences(
  text: string,
  roster: readonly string[],
  allowed: readonly string[],
): string {
  if (roster.length === 0 || allowed.length === 0) return text;
  const segs = sentences(text);
  if (segs.length <= 1) return text;
  const kept = segs.filter((s) => forbiddenNames(s, roster, allowed).length === 0);
  if (kept.length === segs.length) return text; // nothing dropped
  const out = kept.join(" ").trim();
  return tokens(out).length >= 5 ? out : text; // too little left → leave it for the guard
}

/**
 * Drop whole SENTENCES that carry a hallucination marker (night-confusion, physical tell, invented
 * demeanour, CJK), keeping the clean ones. The weak model often produces a strong line plus ONE bad
 * sentence — most damagingly a power-role CLAIM ("I'm the Detective, I investigated Dmitri — he's
 * Mafia. Vote him out.") wrapped around a fabricated "he's been evasive tonight" justification that
 * would otherwise nuke the WHOLE reveal/bluff to a bland fallback. Salvaging the clean sentences keeps
 * the drama (mirrors {@link stripLeadingEcho}). Returns the original when nothing is dropped, or when
 * the salvage would leave too little to be a real contribution (then reject→regenerate→fallback runs).
 */
export function stripMarkedSentences(text: string): string {
  const segs = sentences(text);
  if (segs.length <= 1) return text; // a single sentence is all-or-nothing — nothing to salvage
  const kept = segs.filter((s) => !sentenceHasBadMarker(s));
  if (kept.length === segs.length) return text; // nothing dropped
  const out = kept.join(" ").trim();
  return tokens(out).length >= 5 ? out : text; // too little left → leave it for the guard
}

/** Third-person verbs/copulas the model uses when it (wrongly) narrates ITSELF from outside. */
const THIRD_PERSON_VERB =
  "is|are|was|were|has|have|had|seems?|appears?|looks?|sounds?|keeps?|been|did|does|doesn'?t|isn'?t|hasn'?t|won'?t|tends?|acts?|stays?|remains?";

/**
 * True if the speech narrates the SPEAKER in the third person — "Cassius has been vocal", "Felix is
 * handling himself", "Cassius' lack of substance" — when the speaker IS Cassius/Felix. The weak model
 * confuses its own identity on a name-labelled transcript and ends up arguing about (even against)
 * itself, which reads as nonsense and slips past the other guards because it has no marker. A bare
 * self-introduction ("I'm Felix") is fine — only a third-person predicate/possessive on the own name
 * trips it. Used by the day guard to force a first-person rewrite.
 */
export function refersToSelfInThirdPerson(text: string, selfName: string): boolean {
  if (!selfName) return false;
  const n = escapeRe(selfName);
  // Possessive "Name's" or "Name'" (the elided s after a name ending in s, e.g. "Cassius'"), OR
  // "Name <third-person verb>". A bare "I'm Name" self-intro has neither, so it is not flagged.
  const possessive = new RegExp(`\\b${n}['’]`, "i");
  const subject = new RegExp(`\\b${n}\\s+(?:${THIRD_PERSON_VERB})\\b`, "i");
  // Self-ADDRESS: the model talks TO itself by name in the second person ("Oracle, share your
  // thoughts", "Oracle, why haven't you spoken?"). Anchored to a clause start AND requiring a
  // second-person cue (you/your/please) in the same sentence, so a mid-line self-intro
  // ("I'm Felix, and…") or a plain opener ("Felix, here —") is NOT flagged.
  const vocative = new RegExp(`(?:^|[.!?]\\s+)${n}\\s*,[^.!?]*\\b(?:you|your|please)\\b`, "i");
  return possessive.test(text) || subject.test(text) || vocative.test(text);
}

/**
 * The cleared-Town names a Detective's DAY speech ACCUSES — i.e. pushes today's vote onto, or
 * predicates suspicion of. A Detective that has privately learned a seat is TOWN must never publicly
 * turn the table against it: doing so inverts its own certain knowledge and railroads an innocent
 * (seen live: investigated Esme=TOWN, then "today's vote should focus on Esme… she's hiding
 * something… vote her out"). The prompt already steers a cleared Detective to VOUCH, but the weak
 * model ignores that conditional instruction, so this is the reliable guard layer. It is sentence-
 * scoped with a PROTECTIVE override, so a genuine vouch/defence ("Esme is innocent — look at Boris
 * instead") is never flagged: the check is biased toward precision because a false reject collapses
 * the line to a bland fallback (the documented root cause of dull matches), and a missed nuance is
 * far cheaper than that. Returns the accused cleared names (empty = the speech is clean or vouches).
 */
export function accusesClearedTown(text: string, clearedNames: readonly string[]): string[] {
  if (clearedNames.length === 0) return [];
  // A cleared name as the OBJECT of a vote/removal/suspicion verb ("vote Esme out", "focus on Esme").
  const VOTE_VERB =
    "vote|voting|votes|voted|suspect|suspects|distrust|accuse|accuses|blame|blames|remove|removes|eliminat\\w*|oust|ousts|target|targets|focus(?:es|ing)?";
  // A cleared name as the SUBJECT of a suspicion predicate ("Esme is suspicious", "Esme's hiding it").
  // A linking verb, optionally with an intervening intensifier ("Esme really is suspicious").
  const LINK_VERB =
    "is|are|was|were|seems?|looks?|appears?|sounds?|has\\s+been|have\\s+been|might\\s+be|may\\s+be|could\\s+be|must\\s+be|keeps?|been|acts?|acting|behav\\w*|is\\s+being";
  const ADVERB =
    "really|clearly|definitely|certainly|obviously|honestly|probably|surely|totally|absolutely|actually|truly|genuinely|seriously|just|still|always|now|sure|kind\\s+of|sort\\s+of";
  const SUSPICION =
    "suspicious|guilty|mafia|hiding|hides|lying|liar|shady|evasive|secretive|sketchy|deceptive|deceiv\\w*|dangerous|untrustworthy|culprit|fishy|deflect\\w*|dodg\\w*|cover(?:ing|s)?\\s+(?:up|something)|the\\s+(?:threat|problem|killer|mafia)";
  // Any of these in the SAME sentence means the line is defending/clearing the name, not accusing it —
  // so we do NOT flag (vouching for a cleared seat is exactly what the Detective is supposed to do).
  // Contractions (won't/can't/isn't…) require the apostrophe so plain "-nt" words (front, want) don't trip it.
  const PROTECTIVE =
    /\b(?:innocent|trust(?:s|ed|worthy)?|vouch\w*|clear(?:ed|s)?|clean|safe|defend\w*|protect\w*|spare|stand\s+(?:with|by)|side\s+with|believe\s+in|not|never|stop|wrong\w*|leave|off\s+the\s+hook)\b|\b\w+n['’]t\b/i;
  const hits = new Set<string>();
  for (const name of clearedNames) {
    const n = escapeRe(name);
    const nameRe = new RegExp(`\\b${n}\\b`, "i");
    const obj = new RegExp(`\\b(?:${VOTE_VERB})\\b(?:\\s+\\w+){0,3}?\\s+(?:for|out|against|on)?\\s*\\b${n}\\b`, "i");
    const subjPoss = new RegExp(`\\b${n}['’]s?\\b[^.!?]{0,40}?\\b(?:${SUSPICION})`, "i");
    const subjVerb = new RegExp(
      `\\b${n}\\b(?:\\s+(?:${ADVERB})){0,2}\\s+(?:${LINK_VERB})\\b[^.!?]{0,40}?\\b(?:${SUSPICION})`,
      "i",
    );
    const subj = (s: string): boolean => subjPoss.test(s) || subjVerb.test(s);
    const removal = new RegExp(
      `\\b${n}\\b[^.!?]{0,30}?\\b(?:out\\s+today|should\\s+(?:be\\s+(?:removed|voted|eliminated|gone|out)|go|leave)|needs?\\s+to\\s+go|has\\s+to\\s+go|deserves?\\s+the\\s+vote)`,
      "i",
    );
    for (const s of sentences(text)) {
      if (!nameRe.test(s)) continue;
      if ((obj.test(s) || subj(s) || removal.test(s)) && !PROTECTIVE.test(s)) {
        hits.add(name);
        break;
      }
    }
  }
  return [...hits];
}

/** Correction appended when regenerating a rejected speech for a hallucination marker. */
const MARKER_NOTE =
  "Your previous reply was REJECTED: it treated the unobservable night, a still-silent player, or " +
  "made-up physical behaviour as if it were evidence. This is a TEXT game — there is no eye contact, " +
  "body language, tone, or appearance to read, and no one can observe the night. It is daytime and " +
  "players speak in turn, so a player who has not spoken yet is just waiting, never suspicious. " +
  'Rewrite WITHOUT the words "tonight", "silent", or "silence", without inventing anyone\'s ' +
  "manner or how they carry themselves, and ground it ONLY in words a player actually typed above.";

/** Correction appended when a speech contained non-English (CJK) text. */
const LANGUAGE_NOTE =
  "Your previous reply was REJECTED because it was not fully in English. Write your ENTIRE reply in English.";

/** Correction appended when regenerating a speech that parroted another player. */
const ECHO_NOTE =
  "Your previous reply was REJECTED for repeating what another player already said. Drop that wording " +
  "entirely and make the SPECIFIC move the instruction at the end of the prompt asks for, in completely " +
  "fresh words — a different point from a different angle, never a reword of anyone else's line.";

/** Correction appended when the speech narrates the speaker itself in the third person. */
const selfRefNote = (name: string): string =>
  `Your previous reply was REJECTED because it talked about ${name} in the third person — but YOU are ${name}. ` +
  `Speak as "I" / "me"; never describe ${name} from the outside or argue against your own words.`;

/** Correction appended when a speech invented behaviour for a player who has not spoken yet. */
const fabricationNote = (names: readonly string[]): string =>
  `Your previous reply was REJECTED: it referred to ${names.join(" and ")}, who ${
    names.length > 1 ? "have" : "has"
  } NOT spoken yet, so you cannot know anything about ${names.length > 1 ? "them" : "them"}. ` +
  "Players speak in turn. Rewrite WITHOUT mentioning anyone who has not spoken above — react only to " +
  "players whose own lines actually appear in the discussion, or make a general point that names no one.";

/** Correction appended when a Detective's speech accuses a seat its own investigation has CLEARED. */
const clearedTownNote = (names: readonly string[]): string => {
  const list = names.join(" and ");
  const plural = names.length > 1;
  return (
    `Your previous reply was REJECTED: your own secret investigation already proved ${list} ` +
    `${plural ? "are" : "is"} innocent Town. Never push today's vote onto ${list} and never call ` +
    `${plural ? "them" : list} a suspect — defend ${plural ? "them" : list} if the table turns that way, ` +
    `and aim your suspicion only at a player you have NOT cleared.`
  );
};

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
  selfName = "",
  clearedNames: readonly string[] = [],
): Promise<string> {
  // Salvage BEFORE judging: strip a leading verbatim echo of an earlier line (so the genuine point
  // after a copied preamble survives), then drop any single hallucinated sentence (so a strong reveal/
  // bluff wrapped around one bad "evasive tonight" line survives instead of being nuked whole), then
  // strip transcript-format labels. Only what's left is judged — the dominant round-1 reject modes.
  const clean = (t: string): string =>
    stripSpeakerLabels(
      stripForbiddenNameSentences(
        stripMarkedSentences(stripEchoedSentences(stripLeadingEcho(t, priorTexts), priorTexts)),
        names,
        allowedNames,
      ),
      names,
    );
  const note = (t: string): string => {
    const parts: string[] = [];
    if (hasNonEnglish(t)) parts.push(LANGUAGE_NOTE);
    // Per-sentence + night-claim-aware: a Detective reveal / Mafia bluff may cite its own night
    // investigation; only OTHER fabrication (or a non-claim night reference) trips MARKER_NOTE.
    else if (sentences(t).some((s) => sentenceHasBadMarker(s))) parts.push(MARKER_NOTE);
    if (isEcho(t, priorTexts)) parts.push(ECHO_NOTE);
    if (refersToSelfInThirdPerson(t, selfName)) parts.push(selfRefNote(selfName));
    // Only enforce the forbidden-name check when an allow-list is supplied; with none, every name
    // is permitted (back-compat for callers that don't track who has spoken).
    if (allowedNames.length > 0) {
      const bad = forbiddenNames(t, names, allowedNames);
      if (bad.length > 0) parts.push(fabricationNote(bad));
    }
    // A Detective accusing a seat it has privately cleared as Town inverts its own certain knowledge
    // and railroads an innocent — the prompt steers it to vouch, but the weak model ignores that, so
    // reject the line here. Only the day-discussion caller supplies clearedNames (empty otherwise).
    const accusedCleared = accusesClearedTown(t, clearedNames);
    if (accusedCleared.length > 0) parts.push(clearedTownNote(accusedCleared));
    return parts.join(" ");
  };
  dayGuard.total++;
  const first = clean(rawText);
  const firstNote = note(first);
  if (firstNote === "") {
    logGuardStats();
    return first;
  }
  dayGuard.rejected++; // the raw speech was rejected → a regeneration call is now made
  // Opt-in diagnostics: GUARD_DEBUG surfaces WHY a speech was rejected (which is otherwise invisible —
  // only the bland fallback reaches the transcript), so prompt tuning can target the real failure mode.
  const dbg = (stage: string, t: string) => {
    if (process.env.GUARD_DEBUG) console.error(`\n[GUARD ${stage}] reject: ${note(t)}\n  raw: ${t.replace(/\n/g, " ⏎ ")}`);
  };
  dbg("1st", first);
  try {
    const retry = await provider.complete(`${basePrompt}\n\n${firstNote}`, opts);
    const retried = clean(retry.text);
    if (note(retried) === "") {
      logGuardStats();
      return retried;
    }
    dbg("retry", retried);
  } catch {
    // fall through to the safe fallback
  }
  dayGuard.fallback++; // the regeneration also failed → the canned fallback enters the transcript
  if (process.env.GUARD_DEBUG) console.error(`[GUARD → FALLBACK] ${fallback}`);
  logGuardStats();
  return fallback;
}

/**
 * Diagnostics: how often a DAY speech is rejected by the guard (and thus regenerated), and how often
 * the regeneration also fails so the canned fallback is used. Counted across both the discussion and
 * the vote speech. Logged only when `GUARD_STATS` is set, so it never noises up the test output.
 */
const dayGuard = { total: 0, rejected: 0, fallback: 0 };
function logGuardStats(): void {
  if (!process.env.GUARD_STATS || dayGuard.total % 5 !== 0) return;
  const pct = (n: number): number => Math.round((100 * n) / dayGuard.total);
  console.log(
    `[guard] ${dayGuard.rejected}/${dayGuard.total} day speeches rejected→regenerated (${pct(dayGuard.rejected)}%), ` +
      `${dayGuard.fallback} fell to the canned fallback (${pct(dayGuard.fallback)}%)`,
  );
}
