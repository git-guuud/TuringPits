/**
 * Minimal hash-based router. Three screens — the lobby (menu), the live arena, and the battle
 * history — keyed off `location.hash`. Hash routing needs no server rewrite config and keeps the
 * app a static bundle. The live WebSocket is connected only while the "live" route is active (see
 * App + matchStore), so a match is launched only when someone is actually on the live screen.
 */
import { useEffect, useState } from "react";

export type Route = "menu" | "live" | "history";

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  return h === "live" || h === "history" ? h : "menu";
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(route: Route): void {
  window.location.hash = route === "menu" ? "/" : `/${route}`;
}
