import { useEffect, useState } from "react";

/**
 * Count down to an epoch-ms target, ticking once a second. `target` is the server's projected
 * betting-close time (`MarketSnapshot.closesAt`); each `market` push refreshes it, and this hook
 * smooths the gaps between those pushes. Returns null when there is no active target.
 */
export function useCountdown(target: number | null | undefined): { ms: number; label: string } | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (target == null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  if (target == null) return null;
  const ms = Math.max(0, target - now);
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return { ms, label: `${m}:${s.toString().padStart(2, "0")}` };
}
