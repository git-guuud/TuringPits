import { useEffect, useState } from "react";
import { fetchMatchStatus, type MatchStatus } from "./contract.js";

/**
 * Poll the server's read-only `/status` while mounted, so the lobby can show whether court is in
 * session (round, pot) without opening the live WebSocket — a socket would trip the server's
 * `waitForFirstClient` and START a match. Polls every `intervalMs` (default 5s), pausing while the
 * tab is hidden, and fetches once immediately on mount. Returns null until the first read lands (or
 * when the server is unreachable) — the caller treats null as "court is dark".
 */
export function useLiveStatus(intervalMs = 5000): MatchStatus | null {
  const [status, setStatus] = useState<MatchStatus | null>(null);

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      if (document.hidden) return;
      const s = await fetchMatchStatus();
      if (!stop) setStatus(s);
    };
    void poll();
    const id = setInterval(() => void poll(), intervalMs);
    const onVisible = () => {
      if (!document.hidden) void poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [intervalMs]);

  return status;
}
