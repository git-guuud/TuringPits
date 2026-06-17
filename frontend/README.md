# @turingpits/frontend

The Live Arena UI (Vite + React + TypeScript). Clean, polished — not a prototype.

Day 6 build:
- Streaming chess board + live move feed (WebSocket from `@turingpits/server`).
- Betting panel: connect wallet, YES/NO pools, place bet, state transitions
  (open → locked → settled → claimable) read from the deployed contract, claim.
- Trust strip: commit hash shown pre-bet, seed revealed post-lock,
  "Verified by 0G Compute" badge on settle.

Any mocked element must be visibly labeled as mocked in the UI.

```bash
npm run dev      # http://localhost:5173
npm run build
```
