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

export interface VoiceApi {
  /** True only when the server reports a configured TTS key — gates the toggle and all playback. */
  available: boolean;
  /** Audible (the inverse of muted), persisted across reloads. */
  on: boolean;
  toggle: () => void;
  /** Voice a line, replacing whatever is currently playing. No-op when unavailable or muted. */
  speak: (line: SpeakLine) => void;
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
    (line: SpeakLine) => {
      if (!available || getMuted() || !line.text.trim()) return;
      const myToken = ++tokenRef.current;
      audioRef.current?.pause();
      fetchClip(line)
        .then((url) => {
          if (myToken !== tokenRef.current) return; // a newer line superseded this one
          const a = new Audio(url);
          audioRef.current = a;
          // Autoplay may be blocked until a gesture; the live page is reached by a click, so this
          // normally succeeds. Swallow rejection rather than surface a console error.
          a.play().catch(() => {});
        })
        .catch(() => {});
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

  return { available, on, toggle, speak, stop };
}
