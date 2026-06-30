import { useCallback, useEffect, useRef, useState } from "react";
import { fetchClip, ttsInfo, type SpeakLine } from "./voice.js";

/**
 * The character-voice control + player. Probes the server once for whether speech is configured
 * (`available`), and exposes a persisted mute toggle shaped like {@link useSound}/{@link useMusic}
 * (`{ on, toggle }`) so it slots into the same audio-control row. `speak` plays a line's clip
 * alongside the typewriter; a new line supersedes the one before it, so two seats never overlap.
 *
 * Gated end-to-end: when `available` is false (no server key) nothing is ever fetched or played.
 */
const MUTE_KEY = "tp-voice-muted";

function getMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}
function setMutedFlag(value: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, value ? "1" : "0");
  } catch {
    /* private mode — in-memory only via the `on` state */
  }
}

/** Optional hooks the caller can attach to a single spoken line so the stage can pace itself by audio. */
export interface SpeakHandlers {
  /**
   * Fires once this line's audio finishes — whether it played to the end, failed to load, or was
   * muted (so nothing plays). Lets the stage hold a beat for exactly as long as the voice needs and no
   * longer. Never fires for a line that was superseded by a newer `speak` (the stage already moved on).
   */
  onEnded?: () => void;
}

export interface VoiceApi {
  /** True only when the server reports a configured TTS key — gates the toggle and all playback. */
  available: boolean;
  /** Audible (the inverse of muted), persisted across reloads. */
  on: boolean;
  toggle: () => void;
  /** Voice a line, replacing whatever is currently playing. No-op when unavailable or muted. */
  speak: (line: SpeakLine, handlers?: SpeakHandlers) => void;
  /**
   * Warm a line's clip into the cache WITHOUT playing it, so the upcoming beat plays the instant it
   * reaches the stage instead of waiting on a tag+synth round-trip. No-op when unavailable.
   */
  prefetch: (line: SpeakLine) => void;
  /** Stop whatever is playing (e.g. on narration beats). */
  stop: () => void;
}

export function useVoice(): VoiceApi {
  const [available, setAvailable] = useState(false);
  const [on, setOn] = useState(() => !getMuted());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Monotonic token so a slow fetch that resolves after a newer line started never plays late.
  const tokenRef = useRef(0);

  useEffect(() => {
    let alive = true;
    void ttsInfo().then((info) => {
      if (alive) setAvailable(!!info?.enabled);
    });
    return () => {
      alive = false;
    };
  }, []);

  const stop = useCallback(() => {
    tokenRef.current++;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.src = "";
      audioRef.current = null;
    }
  }, []);

  const speak = useCallback(
    (line: SpeakLine, handlers?: SpeakHandlers) => {
      // When the line can't or won't be voiced, report "ended" immediately so a caller pacing on the
      // audio doesn't stall waiting for a clip that will never play.
      if (!available || getMuted() || !line.text.trim()) {
        handlers?.onEnded?.();
        return;
      }
      const myToken = ++tokenRef.current;
      // Fire onEnded at most once, and only while this is still the current line (a superseded line
      // must NOT advance the stage — the newer line already did).
      let done = false;
      const finish = () => {
        if (done || myToken !== tokenRef.current) return;
        done = true;
        handlers?.onEnded?.();
      };
      audioRef.current?.pause();
      fetchClip(line)
        .then((url) => {
          if (myToken !== tokenRef.current) return; // a newer line superseded this one
          const a = new Audio(url);
          audioRef.current = a;
          a.onended = finish;
          a.onerror = finish;
          // Autoplay may be blocked until a gesture; the live page is reached by a click, so this
          // normally succeeds. Swallow rejection rather than surface a console error.
          a.play().catch(() => {});
        })
        .catch(finish); // synth/transport failure — let the stage move on after its tail
    },
    [available],
  );

  const prefetch = useCallback(
    (line: SpeakLine) => {
      if (!available || !line.text.trim()) return;
      // Warm the clip (and the server-side tag+synth cache) without playing or touching the token, so
      // the current line keeps playing while the next one is readied.
      fetchClip(line).catch(() => {});
    },
    [available],
  );

  const toggle = useCallback(() => {
    setOn((prev) => {
      const next = !prev;
      setMutedFlag(!next);
      if (!next) stop(); // muting cuts the current line immediately
      return next;
    });
  }, [stop]);

  // Stop any audio when the consumer unmounts (leaving the live screen).
  useEffect(() => stop, [stop]);

  return { available, on, toggle, speak, prefetch, stop };
}
