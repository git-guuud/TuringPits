import { useEffect, useRef, useState } from "react";

/**
 * Two looping background tracks — one for day, one for night — crossfaded by the playback phase.
 * Both elements play at once; only the active phase is audible, the other rides at volume 0, so the
 * day↔night handoff is a smooth fade rather than a restart. Playback is user-toggled (the click is
 * also the gesture that satisfies the browser autoplay policy); missing files fail silently.
 *
 * Drop the tracks here (Vite serves `public/` at the site root):
 *   frontend/public/audio/day.mp3
 *   frontend/public/audio/night.mp3
 */
const DAY_SRC = "/audio/day.mp3";
const NIGHT_SRC = "/audio/night.mp3";
const FULL_VOL = 0.5; // ceiling so music sits under the typewriter/voices
const FADE_MS = 2400;

export function useMusic(night: boolean): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(true);
  const day = useRef<HTMLAudioElement | null>(null);
  const ngt = useRef<HTMLAudioElement | null>(null);
  const raf = useRef<number | null>(null);

  // Build the two elements once.
  useEffect(() => {
    const mk = (src: string) => {
      const a = new Audio(src);
      a.loop = true;
      a.preload = "auto";
      a.volume = 0;
      return a;
    };
    day.current = mk(DAY_SRC);
    ngt.current = mk(NIGHT_SRC);
    return () => {
      day.current?.pause();
      ngt.current?.pause();
      day.current = null;
      ngt.current = null;
    };
  }, []);

  // Start/stop both elements with the toggle.
  useEffect(() => {
    const d = day.current;
    const n = ngt.current;
    if (!d || !n) return;
    if (on) {
      d.play().catch(() => {});
      n.play().catch(() => {});
      // Browsers block autoplay until a user gesture; since music defaults on, retry once on
      // the first interaction so it starts without the spectator having to find the toggle.
      const kick = () => {
        d.play().catch(() => {});
        n.play().catch(() => {});
        window.removeEventListener("pointerdown", kick);
        window.removeEventListener("keydown", kick);
      };
      window.addEventListener("pointerdown", kick);
      window.addEventListener("keydown", kick);
      return () => {
        window.removeEventListener("pointerdown", kick);
        window.removeEventListener("keydown", kick);
      };
    }
    d.pause();
    n.pause();
  }, [on]);

  // Crossfade toward the active phase whenever the phase (or on/off) changes.
  useEffect(() => {
    const d = day.current;
    const n = ngt.current;
    if (!d || !n) return;
    const targetDay = on && !night ? FULL_VOL : 0;
    const targetNgt = on && night ? FULL_VOL : 0;
    const startDay = d.volume;
    const startNgt = n.volume;
    const t0 = performance.now();
    if (raf.current) cancelAnimationFrame(raf.current);
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / FADE_MS);
      d.volume = Math.max(0, Math.min(1, startDay + (targetDay - startDay) * k));
      n.volume = Math.max(0, Math.min(1, startNgt + (targetNgt - startNgt) * k));
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [night, on]);

  return { on, toggle: () => setOn((v) => !v) };
}
