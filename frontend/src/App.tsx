import { useMatch } from "./state/matchStore.js";
import { useRoute } from "./lib/useRoute.js";
import { Menu } from "./components/screens/Menu.js";
import { Live } from "./components/screens/Live.js";
import { History } from "./components/screens/History.js";
import { HowItWorks } from "./components/tribunal/HowItWorks.js";
import { TxToaster } from "./components/TxToaster.js";

export function App() {
  const route = useRoute();
  // One match store for the whole app: the wallet connection persists across screens, while the live
  // WebSocket connects ONLY on the live route — so a match is launched only when someone is watching.
  const api = useMatch({ live: route === "live" });

  return (
    <>
      {route === "menu" && <Menu api={api} />}
      {route === "live" && <Live api={api} />}
      {route === "history" && <History api={api} />}

      {/* The "?" primer is available everywhere (bottom-right). */}
      <HowItWorks />

      {/* App-wide confirmation/receipt toasts for every on-chain wager/claim, on every route. */}
      <TxToaster api={api} />
    </>
  );
}
