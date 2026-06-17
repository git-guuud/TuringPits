/**
 * Sequencer + WebSocket move streaming (TODO.md Day 6).
 *
 * Responsibilities:
 *  - Generate the secret seed, commit its hash on-chain before betting opens.
 *  - Run the deterministic match via @turingpits/engine.
 *  - Stream calculated moves to the frontend over WebSocket at 1 move/second to
 *    create the suspenseful live spectacle (the match is already fully computed;
 *    the pacing is purely for viewing).
 *  - After the stream, upload the PGN battle log to 0G Storage.
 *
 * TODO(Day 6): implement. Stub entrypoint below.
 */

const PORT = Number(process.env.PORT ?? 8080);
const MOVE_INTERVAL_MS = 1000; // 1 move/sec viewing pace

function main() {
  // TODO(Day 6): start ws.Server on PORT, drive matches, stream at MOVE_INTERVAL_MS.
  console.log(`[turingpits server] scaffold — would listen on :${PORT}`);
  void MOVE_INTERVAL_MS;
}

main();
