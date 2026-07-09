# Deploying TuringPits to Vercel

This guide gets the **frontend** (the spectator UI — "The Tribunal") live on Vercel.

> **Read this first — what Vercel does and does not host.**
>
> Vercel hosts **only the frontend** (`frontend/`), a static Vite + React single-page app. It is
> a static bundle: it talks straight to the deployed `MafiaMarket` contract on 0G Galileo (reads
> via public RPC, writes via the viewer's wallet) and streams the live match over a WebSocket.
>
> The **match server** (`server/`, the WebSocket on `:8080` that runs the engine + 0G players and
> settles on-chain) is a **long-lived stateful process and will NOT run on Vercel** — Vercel's
> serverless/edge functions can't hold an open WebSocket or run a persistent match loop, and the
> host private key has no safe home there. Host the server somewhere persistent (Railway, Render,
> Fly.io, or any VM/container) and point the frontend at it with `VITE_WS_URL` (see step 4 and the
> "Match server" section at the bottom). Without that, the UI loads and on-chain betting works, but
> the **live feed will not connect**.

---

## 1. Prerequisites

- A Vercel account, and the repo pushed to GitHub/GitLab/Bitbucket (Vercel deploys from a Git repo).
- The match server already running somewhere with a public `wss://` URL — **or** accept that the
  live feed is dark for this deploy (betting/history still work). See the last section.
- (Optional) The [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`.

No secrets are baked into the frontend — everything it needs is public (contract address, RPC) or a
client-side WebSocket URL. The on-chain market is **testnet only** and bets use the faucet-mintable
`CHIP` mock token (no real funds).

---

## 2. Import the project into Vercel

1. Vercel dashboard → **Add New… → Project** → import the TuringPits repo.
2. On the configuration screen, set **Root Directory** to **`frontend`**.
   - This is the single most important setting. The repo is an npm-workspaces monorepo; the
     frontend is self-contained (its own `package-lock.json`, no `@turingpits/*` imports), so
     pointing Vercel at `frontend/` lets it install and build in isolation.

---

## 3. Build & output settings

With Root Directory = `frontend`, Vercel auto-detects **Vite**. Confirm these (defaults are correct):

| Setting | Value |
|---|---|
| **Framework Preset** | Vite |
| **Build Command** | `npm run build`  (runs `tsc -b && vite build`) |
| **Output Directory** | `dist` |
| **Install Command** | `npm install`  (uses `frontend/package-lock.json`) |
| **Node.js Version** | 20.x or newer (Project → Settings → General) |

No `vercel.json` is required. The app uses **hash-based routing** (`#/live`, `#/history`), so there
is no need for an SPA rewrite/fallback — every route is served by the same `index.html`.

---

## 4. Environment variables

Set these under **Project → Settings → Environment Variables** (apply to Production + Preview). They
are read at **build time** (Vite inlines `VITE_*` vars into the bundle), so **re-deploy after any
change** — editing a var does not retroactively patch an existing deployment.

| Variable | Required? | Purpose |
|---|---|---|
| `VITE_WS_URL` | **Yes, for the live feed** | Full WebSocket URL of the match server, e.g. `wss://your-server.example.com`. If unset, the app derives `wss://<page-host>/ws`, which only works when the server is proxied behind the same domain (the local ngrok setup) — on a plain Vercel domain that path 404s, so **set this explicitly**. |
| `VITE_TTS_URL` | **Yes, if you enabled spoken dialogue** | HTTPS URL of the **same** match server (the `/tts` + `/tts/info` routes ride the same port as the WebSocket): the `VITE_WS_URL` host with `https://` instead of `wss://`, e.g. `https://your-server.example.com`. If unset, the app looks for `/tts/info` on its **own Vercel origin** (the `vite.config.ts` `/tts` proxy is dev-only and does not exist in a production build), gets a 404, and **silently disables voices** — even though the server has the ElevenLabs key. |
| `VITE_RELAYER_URL` | Only for gasless betting | HTTPS URL of the same match server, as above. Same dev-proxy-only caveat as `VITE_TTS_URL`; leave unset to disable the optional gasless relay. |
| `VITE_MARKET_ADDRESS` | No | Override the `MafiaMarket` contract address. Defaults to the deployed `0x35fCb9De839700ED139077ECB183257dD10C581f` (0G Galileo, chain `16602`). Only set this if you redeploy the contract. |

> The frontend has **no other secrets**. The 0G RPC, chain ID, explorer, and faucet URLs are
> hardcoded constants in `frontend/src/lib/contract.ts`.

---

## 5. Deploy

- **Dashboard:** click **Deploy**. Vercel installs, runs `npm run build`, and serves `dist/`.
- **CLI (from repo root):**
  ```bash
  cd frontend
  vercel          # first run links/creates the project — set root to . (you're already in frontend)
  vercel --prod   # promote to production
  ```

After it builds, open the deployment URL. You should see the lobby; **Watch live** connects to
`VITE_WS_URL`, and **History** reads past matches straight from the contract over public RPC (works
even with the server offline).

---

## 6. Post-deploy checklist

- [ ] Lobby loads at the Vercel URL.
- [ ] **History** lists past matches (proves public-RPC contract reads work — no server needed).
- [ ] Connecting a wallet prompts to switch to **0G Galileo** (chain `16602`); "Get test tokens"
      mints `CHIP`.
- [ ] **Watch live** opens a WebSocket to `VITE_WS_URL` and the feed streams (proves the server is
      reachable over `wss://` with TLS — a plain `ws://` URL will be blocked as mixed content on an
      HTTPS Vercel page).

---

## Match server (the part Vercel can't host)

The live feed needs `server/` running as a persistent process. To wire it up:

1. **Host it** on a platform that supports long-running processes + WebSockets: Railway, Render,
   Fly.io, a VM, or a container host. Build/run with the existing scripts:
   ```bash
   npm install              # at repo root (workspaces)
   npm run build            # builds engine, players, server, …
   node server/dist/index.js   # or: npm start --workspace @turingpits/server
   ```
2. **Give it the server env** (host private key, 0G keys, RPC, etc.) from `.env.example` — these are
   real secrets and must live on the server host, **never** in Vercel/the frontend bundle.
3. **Expose TLS.** The host must serve the WebSocket over `wss://` (HTTPS), because the Vercel page
   is HTTPS and browsers block insecure `ws://` from a secure page. Most of the platforms above
   terminate TLS for you.
4. **Point the frontend at it:** set `VITE_WS_URL=wss://<your-server-host>` in Vercel and re-deploy.

> For purely local demos you can keep the original flow instead: run the server on `:8080`, run
> `vite` locally, and share one ngrok tunnel — `vite.config.ts` already proxies `/ws` to `:8080`.
> That path is for local sharing; the Vercel path above is for a stable public deployment.
