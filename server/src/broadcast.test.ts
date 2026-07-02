import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { Hub } from "./broadcast.js";
import type { PublicGameState, RecordCommit, WsMessage } from "./wire.js";

// Bind the hub to a NON-listening HTTP server so the WS server attaches no real port — snapshot()
// reads only the in-memory buffer, so we never need a live socket and there's nothing to tear down.
function newHub(): Hub {
  return new Hub(createServer());
}

const record: RecordCommit = {
  roleCommit: "0x",
  teeSigner: "0x",
  providerType: "MOCK-local",
  providerIdentity: "test",
  tlsFingerprint: "0x",
  playerCount: 6,
};

const init = (matchId: number): WsMessage => ({
  type: "match_init",
  nonce: "n",
  personas: [],
  record,
  isMock: true,
  marketAddress: "0xMarket",
  matchId,
  chainId: 16602,
});

const gameState = (round: number): PublicGameState => ({
  nonce: "n",
  phase: "day",
  round,
  players: [],
  winner: null,
});

describe("Hub.snapshot — lobby status from the replay buffer", () => {
  it("reports idle before any match has begun", () => {
    const s = newHub().snapshot();
    expect(s.live).toBe(false);
    expect(s.round).toBe(0);
    expect(s.matchId).toBeNull();
  });

  it("reports a live match with its highest round and latest pools mid-play", () => {
    const hub = newHub();
    const msgs: WsMessage[] = [
      init(7),
      { type: "market", market: { state: "OPEN", bettingLive: false, yesPool: "0", noPool: "0" } },
      { type: "night", round: 1 },
      { type: "market", market: { state: "OPEN", bettingLive: true, yesPool: "5", noPool: "7" } },
      { type: "dawn", round: 2, killed: [3], saved: 0, state: gameState(2) },
    ];
    for (const m of msgs) hub.broadcast(m);
    const s = hub.snapshot();
    expect(s.live).toBe(true);
    expect(s.matchId).toBe(7);
    expect(s.round).toBe(2);
    expect(s.bettingLive).toBe(true);
    expect(s.yesPool).toBe("5");
    expect(s.noPool).toBe("7");
  });

  it("flips back to idle once the match settles", () => {
    const hub = newHub();
    hub.broadcast(init(7));
    hub.broadcast({ type: "market", market: { state: "OPEN", bettingLive: true, yesPool: "5", noPool: "7" } });
    hub.broadcast({ type: "settled", outcome: "YES", winningSide: "YES" });
    const s = hub.snapshot();
    expect(s.live).toBe(false);
    expect(s.state).toBe("SETTLED");
  });

  it("clears a prior match on reset so no stale match leaks into the next", () => {
    const hub = newHub();
    hub.broadcast(init(1));
    hub.reset();
    const s = hub.snapshot();
    expect(s.live).toBe(false);
    expect(s.matchId).toBeNull();
  });
});
