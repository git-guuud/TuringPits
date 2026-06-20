import { useEffect, useRef, useState } from "react";

/**
 * Reveal `text` character-by-character for the streaming-testimony effect. Resets whenever the
 * text changes (new speaker takes the stand). Honors `prefers-reduced-motion` by showing the
 * full text immediately.
 */
export function useTypewriter(text: string, charMs = 18): { shown: string; done: boolean } {
  const [shown, setShown] = useState("");
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      if (i < text.length) {
        timer.current = setTimeout(tick, charMs + Math.random() * 22);
      } else {
        setDone(true);
      }
    };
    timer.current = setTimeout(tick, charMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [text, charMs]);

  return { shown, done };
}
