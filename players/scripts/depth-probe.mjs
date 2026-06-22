// Strategic-depth probe: do roles actually USE their role now? Runs the REAL Player path (discuss +
// vote takeTurn, including the moderator guard), so it also exercises the reveal allow-list fix.
//   node --env-file=.env players/scripts/depth-probe.mjs
import * as players from "@turingpits/players";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS ?? process.env.COMPUTE_PROVIDER_ADDRESS;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS in .env");

const ROSTER = [
  { seat: 0, name: "Atlas", blurb: "loud and certain; blunt one-line verdicts, no hedging" },
  { seat: 1, name: "Vesper", blurb: "dry and wry; speaks in understatement and pointed questions" },
  { seat: 2, name: "Cassius", blurb: "formal and precise; makes one careful, lawyerly point" },
  { seat: 3, name: "Wren", blurb: "soft-spoken and steady; gentle, careful phrasing" },
  { seat: 4, name: "Pip", blurb: "chatty and breezy; light, a little joking, disarming" },
];
const alive = [0, 1, 2, 3, 4];
// Atlas (seat 0) has NOT spoken — tests that a Detective can still name+reveal a not-yet-spoken seat.
const transcript = [
  [1, "I'm not sold on anyone yet, but Cassius is talking a lot of process and no substance."],
  [4, "Ha, easy Vesper — give people a chance. I'd rather hear from Wren before we pile on anyone."],
];
const base = (seat, extra) => ({
  persona: ROSTER[seat], role: "TOWN", alive, roster: ROSTER, transcript, deaths: [{ round: 1, phase: "night", seat: 9 }],
  decisionStub: { nonce: "depth", phase: "day", round: 2, player: seat, action: "vote" },
  legalTargets: alive.filter((s) => s !== seat), stage: "discussion", ...extra,
});

const provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Detective (Vesper, seat 1) who investigated Atlas and found MAFIA — should it reveal?
const detective = base(1, { role: "DETECTIVE", investigations: [{ round: 1, target: 0, faction: "MAFIA" }] });
// Mafia (Cassius, seat 2), solo — should it seize initiative and bluff a claim?
const mafia = base(2, { role: "MAFIA", teammates: [] });
// Town (Wren, seat 3) — should it commit to a side, not "watch the vote".
const town = base(3, { role: "TOWN" });

const cases = [
  ["DETECTIVE Vesper (knows Atlas=MAFIA)", detective],
  ["MAFIA Cassius (solo)", mafia],
  ["TOWN Wren", town],
];
let first = true;
for (const [label, ctx] of cases) {
  if (!first) await sleep(7000);
  first = false;
  let out = null;
  for (let a = 0; a < 3 && out === null; a++) {
    try { out = await new players.Player(provider).discuss(ctx); }
    catch (e) { console.warn(`  [retry] ${label}: ${e.message}`); await sleep(7000); }
  }
  console.log(`\n${label}:\n  ${out?.speech}`);
}
