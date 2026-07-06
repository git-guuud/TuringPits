import { useEffect, useRef, useState } from "react";
import { bell, clickKey } from "./typeSound.js";

interface TypewriterOpts {
  /** Base delay per character, in ms. */
  charMs?: number;
  /** Play a procedural keystroke clack as each character is revealed. */
  sound?: boolean;
  /** Ring the carriage-return bell when the text finishes typing (only if `sound`). */
  bell?: boolean;
  /** Clack volume scale (0–1); e.g. quieter while TTS reads the same line aloud. Live — changing it
   *  mid-line takes effect on the next keystroke (read via a ref) rather than restarting the reveal. */
  volume?: number;
}

/**
 * Reveal `text` character-by-character for the streaming-testimony effect. Resets whenever the
 * text changes (new speaker takes the stand). Honors `prefers-reduced-motion` by showing the
 * full text immediately (and stays silent — the sound rides the reveal animation).
 */
export function useTypewriter(text: string, opts: TypewriterOpts = {}): { shown: string; done: boolean } {
  const { charMs = 18, sound = false, bell: ring = false, volume = 1 } = opts;
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Volume rides a ref so it can change mid-line (TTS toggled) without restarting the reveal.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !text) {
      setShown(text);
      setDone(true);
      return;
    }
    setShown("");
    setDone(false);
    let i = 0;
    const tick = () => {
      i += 1;
      setShown(text.slice(0, i));
      // Clacks land on visible keystrokes only — whitespace is silent; the throttle caps cadence.
      if (sound && text[i - 1]?.trim()) clickKey(volumeRef.current);
      if (i < text.length) {
        timer.current = setTimeout(tick, charMs + Math.random() * 22);
      } else {
        setDone(true);
        if (sound && ring) bell();
      }
    };
    timer.current = setTimeout(tick, charMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, charMs, sound, ring]);

  return { shown, done };
}
