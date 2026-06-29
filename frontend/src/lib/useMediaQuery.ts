import { useEffect, useState } from "react";

/**
 * Track a CSS media query as a boolean. The live arena renders two genuinely different layouts —
 * the desktop three-pane (Bench · Court · Verdict) and the narrow stage + bottom bet dock — so this
 * gates which tree mounts rather than toggling visibility (keeps a single Verdict/Bench instance).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
