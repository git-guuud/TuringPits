/**
 * A player's private strategic choice for the turn: which legal seat to target, plus a
 * one-line rationale. Produced by the *reason* inference (the first of the three-call turn).
 * Not load-bearing for settlement — only the constrained decision inference is signed — so
 * its parse is lenient: we extract a legal target even from imperfect model output.
 */
export interface ReasonResult {
  readonly target: number;
  readonly reason: string;
}

/**
 * Extract the chosen target and rationale from the reason inference's output.
 *
 * Primary path: a JSON object `{"target": <legal seat>, "reason": "<text>"}`.
 * Fallback path: the first legal seat integer appearing anywhere in the text (a weak model
 * that narrates instead of emitting JSON still yields a usable choice).
 *
 * Throws when no legal target can be recovered — the caller resamples (and ultimately falls
 * back to a deterministic legal pick), so a poor reasoning turn can never stall the match.
 */
export function parseReason(text: string, legalTargets: readonly number[]): ReasonResult {
  // Weak models often wrap the object in ```json fences or surround it with prose, so try the
  // first {...} substring as well as the whole string. Either way, never let raw JSON/fences leak
  // into `reason` — that text is shown verbatim as the player's private spectacle line.
  const candidates = [text, ...(text.match(/\{[\s\S]*?\}/g) ?? [])];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object") {
        const p = parsed as Record<string, unknown>;
        if (typeof p.target === "number" && Number.isInteger(p.target) && legalTargets.includes(p.target)) {
          const reason = typeof p.reason === "string" ? p.reason : "";
          return { target: p.target, reason };
        }
      }
    } catch {
      // Not valid JSON — try the next candidate, then fall through to lenient extraction.
    }
  }

  // Lenient fallback: a `"reason": "..."` field may still be recoverable from malformed JSON; if
  // not, strip JSON punctuation/fences so the surfaced reason is plain prose, never raw syntax.
  const reasonField = text.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const cleanReason = reasonField
    ? reasonField[1]!.replace(/\\"/g, '"').trim()
    : text.replace(/```[a-z]*|```|[{}"]/gi, "").replace(/\btarget\b\s*:?\s*\d+/gi, "").trim();
  for (const tok of text.match(/\d+/g) ?? []) {
    const n = Number(tok);
    if (legalTargets.includes(n)) return { target: n, reason: cleanReason };
  }

  throw new Error(`reason output names no legal target (legal: ${legalTargets.join(", ")}): ${text}`);
}

/**
 * A DAY vote turn's MERGED output: the chosen target plus the public case for it, produced by one
 * inference instead of a separate reason call and speech call. Under the testnet's token-rate limit
 * a match is throttled by total tokens shipped, so collapsing two ~1.1k-token calls into one is a
 * direct speedup with no settlement impact (the signed decision is still a separate constrained call).
 */
export interface VoteSpeechResult {
  readonly target: number;
  /** The raw public case (still passes through the day-speech guard before broadcast). May be "". */
  readonly speech: string;
}

/**
 * Parse the merged vote call's output. The prompt asks for two labelled lines —
 *   `TARGET: <seat>` / `CASE: <1–2 sentence case>`
 * — which a weak model handles far more reliably than JSON with a long free-text field (no quote
 * escaping to get wrong). Lenient like {@link parseReason}: a `TARGET`/`VOTE` label wins, else the
 * first legal seat integer anywhere; the case is whatever follows `CASE`/`SAY`, else the text minus
 * the target line. Returns null only when NO legal target can be recovered (caller resamples); a
 * recovered target with an empty case signals the caller to fall back to a dedicated speech call.
 */
export function parseVoteSpeech(text: string, legalTargets: readonly number[]): VoteSpeechResult | null {
  const legal = new Set(legalTargets);
  let target: number | undefined;
  const labelled =
    text.match(/\bTARGET\b\s*[:=]?\s*(?:seat\s*)?#?\s*(\d+)/i) ??
    text.match(/\bVOTE\b\s*[:=]?\s*(?:seat\s*)?#?\s*(\d+)/i);
  if (labelled && legal.has(Number(labelled[1]))) target = Number(labelled[1]);
  if (target === undefined) {
    for (const tok of text.match(/\d+/g) ?? []) {
      if (legal.has(Number(tok))) {
        target = Number(tok);
        break;
      }
    }
  }
  if (target === undefined) return null;

  let speech = "";
  const cased = text.match(/\b(?:CASE|SAY|SPEECH)\b\s*[:=]?\s*([\s\S]+)/i);
  if (cased) speech = cased[1]!.trim();
  else speech = text.replace(/\bTARGET\b[^\n]*\n?/i, "").replace(/\bVOTE\b[^\n]*\n?/i, "").trim();
  // Drop wrapping quotes/backticks/code-fences the model sometimes adds around the case.
  speech = speech.replace(/^```[a-z]*\s*|\s*```$/gi, "").replace(/^["'`]+|["'`]+$/g, "").trim();
  return { target, speech };
}
