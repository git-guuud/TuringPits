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
