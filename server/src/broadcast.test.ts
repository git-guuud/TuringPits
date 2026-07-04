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

  // A minimal FACTION-market snapshot (the pot is this market's total stake now that faction is a prop).
  const factionProps = (mafia: string, town: string): WsMessage => ({
    type: "market",
    market: {
      state: "OPEN",
      bettingLive: true,
      props: [{ index: 0, kind: "FACTION", param: 0, numOutcomes: 2, pools: [town, mafia], closed: false }],
    },
  });

  it("reports a live match with its highest round and the faction-market pot mid-play", () => {
    const hub = newHub();
    const msgs: WsMessage[] = [
      init(7),
      { type: "market", market: { state: "OPEN", bettingLive: false, props: [] } },
      { type: "night", round: 1 },
      factionProps("5", "7"), // MAFIA pool 5, TOWN pool 7 → pot 12
      { type: "dawn", round: 2, killed: [3], saved: 0, state: gameState(2) },
    ];
    for (const m of msgs) hub.broadcast(m);
    const s = hub.snapshot();
    expect(s.live).toBe(true);
    expect(s.matchId).toBe(7);
    expect(s.round).toBe(2);
    expect(s.bettingLive).toBe(true);
    expect(s.pot).toBe("12");
  });

  it("flips back to idle once the match settles", () => {
    const hub = newHub();
    hub.broadcast(init(7));
    hub.broadcast(factionProps("5", "7"));
    hub.broadcast({ type: "settled", txHash: "0xabc" });
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
