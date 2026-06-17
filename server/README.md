# @turingpits/server

The off-chain **Sequencer** + WebSocket streamer (Live Arena backend).

Flow per match:
1. Generate secret seed → commit hash on 0G Chain (before betting opens).
2. Run the deterministic match via `@turingpits/engine` (whole game computed up front).
3. Stream moves to the frontend over WebSocket at **1 move/sec** for suspense.
4. After the stream, upload the PGN battle log to 0G Storage via `@turingpits/storage`.

```bash
npm run dev     # tsx watch
npm start       # run built server
```

`PORT` (default 8080). Implementation lands Day 6.
