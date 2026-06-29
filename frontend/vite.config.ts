import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // A leading "." allows the domain and all its subdomains, so any ngrok tunnel works
  // without re-editing this on each restart (the public URL changes per session).
  server: {
    port: 5173,
    allowedHosts: ["backhand-humming-relocate.ngrok-free.dev", ".ngrok-free.dev"],
    // Proxy the live match WebSocket through the dev server so a single ngrok tunnel (serving the
    // UI) also carries the feed: the browser connects to wss://<host>/ws, which lands here and is
    // forwarded to the match server on :8080. See src/lib/feed.ts for the matching client URL.
    proxy: {
      "/ws": { target: "ws://localhost:8080", ws: true, changeOrigin: true },
      // The optional gas-relayer HTTP endpoint (/relay, /relay/info) — proxied like /ws so a single
      // tunnel carries the gasless betting path too. See src/lib/contract.ts resolveRelayUrl.
      "/relay": { target: "http://localhost:8080", changeOrigin: true },
    },
  },
});
