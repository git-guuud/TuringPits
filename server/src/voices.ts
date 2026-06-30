/**
 * Persona → ElevenLabs voice mapping for the optional spoken-dialogue layer (see server/src/tts.ts).
 *
 * Each tribunal persona maps to a curated ElevenLabs *premade* voice, keyed by NAME (not seat) so a
 * given character always sounds the same across matches. The voices are spread across timbres to fit
 * each persona's speaking-style blurb (ROSTER in match-runner.ts). The whole layer is OPTIONAL — it
 * only activates when ELEVENLABS_API_KEY is set; with no key, none of this is reached.
 *
 * Both the map and the fallback are overridable from the environment so IDs can be corrected/customised
 * WITHOUT a code change:
 *   ELEVENLABS_VOICE_MAP        — JSON object of { "Atlas": "<voiceId>", ... }, merged over the defaults
 *   ELEVENLABS_DEFAULT_VOICE_ID — the voice for any unmapped name
 *
 * NOTE: these are well-known ElevenLabs premade voice IDs; they can drift per account/region. If a
 * voice 404s at synthesis time, override it via ELEVENLABS_VOICE_MAP (see myTasks.md).
 */

/**
 * name → ElevenLabs voiceId. 16 distinct voices, one per persona in the roster.
 *
 * These are ElevenLabs' CURRENT default-library voices (the newer, v3-optimised set) rather than the
 * older legacy premades — the legacy ones (Adam/Arnold/Antoni/Josh/Elli/Emily) render flat and synthetic
 * on eleven_v3, which is what sounded "bot-like". The replacements below are the natural, conversational
 * default voices, matched to each persona's blurb.
 */
export const DEFAULT_VOICE_MAP: Readonly<Record<string, string>> = {
  Atlas: "nPczCjzI2devNBz1zQrb", // Brian — deep, resonant, confident (was Adam: robotic)
  Vesper: "XB0fDUnXU5powFXDhCwa", // Charlotte — dry, wry
  Nova: "FGY2WhTYpPnrIDTdsKH5", // Laura — young, warm, earnest (was Elli: robotic)
  Kestrel: "TX3LPaxmHKxFdv7VOQHJ", // Liam — quick, clipped
  Mira: "EXAVITQu4vr4xnSDxMaL", // Sarah — measured, even
  Juno: "onwK4e9ZLuTAKqWW03F9", // Daniel — calm, plainspoken
  Oracle: "CwhRBWXzGAHq8TQ4Fs17", // Roger — weighty, mature, deliberate (was Arnold: robotic)
  Cassius: "JBFqnCBsd6RMkjVDRZzb", // George — formal, lawyerly
  Pip: "pFZP5JQG7iQjIQuC4Bku", // Lily — chatty, breezy
  Rook: "N2lVS1w4EtoT3dr4eOWO", // Callum — terse, grim
  Lark: "XrExE9yKIg1WjnnlVkGX", // Matilda — bright, warm
  Sable: "cjVigY5qzO86Huf0OWal", // Eric — cool, smooth, cynical (was Antoni: robotic)
  Bram: "pqHfZKP75CvOlQylNhV4", // Bill — gruff, direct
  Odette: "Xb7hH8MSUJpSbSDYk0k2", // Alice — poised, precise
  Flint: "IKne3meq5aSn9XLyUdCD", // Charlie — energetic, pushy (was Josh: robotic)
  Wren: "SAz9YHcvj6GT2YYXdXww", // River — calm, gentle, natural (was Emily: robotic)
};

/** Fallback voice for any name not present in the map. Overridable via ELEVENLABS_DEFAULT_VOICE_ID. */
export const DEFAULT_FALLBACK_VOICE = "onwK4e9ZLuTAKqWW03F9"; // Daniel — neutral, calm

/**
 * Parse ELEVENLABS_VOICE_MAP (a JSON object of name→voiceId) and merge it over the built-in defaults.
 * A malformed value is ignored (logged by the caller) so a bad env never disables the whole feature.
 */
export function loadVoiceMap(raw?: string): Record<string, string> {
  const base: Record<string, string> = { ...DEFAULT_VOICE_MAP };
  if (!raw) return base;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [name, id] of Object.entries(parsed)) {
      if (typeof id === "string" && id.trim()) base[name] = id.trim();
    }
  } catch {
    /* caller logs; keep the defaults */
  }
  return base;
}

/** Resolve a persona name to its voice id, falling back to the configured default. */
export function voiceFor(name: string, map: Record<string, string>, fallback: string): string {
  return map[name] ?? fallback;
}
