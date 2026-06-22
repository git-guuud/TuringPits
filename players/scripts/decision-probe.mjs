// FAST decision-prompt probe: hits ONLY the live 0G model (no chain) with the exact prompt the
// real match path uses (buildDecisionPrompt, NO sampling opts), then checks whether the model's
// ENTIRE output is byte-identical to encodeDecision(...). This is the check parseDecision applies,
// so a PASS here means the turn would settle and a FAIL is exactly what abandons a live match.
//
//   node --env-file=.env players/scripts/decision-probe.mjs
import * as players from "@turingpits/players";
import { encodeDecision } from "@turingpits/engine";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS ?? process.env.COMPUTE_PROVIDER_ADDRESS;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS/COMPUTE_PROVIDER_ADDRESS in .env");

const NONCE = "live-probe";
const base = { role: "TOWN", alive: [0, 1, 2, 3, 4], roster: null, transcript: [], deaths: [] };
const scenarios = [
  { label: "day vote",        stub: { nonce: NONCE, phase: "day",   round: 2, player: 2, action: "vote" },        target: 3, legal: [0, 1, 3, 4] },
  { label: "night kill",      stub: { nonce: NONCE, phase: "night", round: 1, player: 1, action: "kill" },        target: 4, legal: [0, 2, 3, 4] },
  { label: "night investigate", stub: { nonce: NONCE, phase: "night", round: 2, player: 0, action: "investigate" }, target: 2, legal: [1, 2, 3, 4] },
];

const provider = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0, first = true;
for (const { label, stub, target, legal } of scenarios) {
  if (!first) await sleep(7000);
  first = false;
  const ctx = { ...base, persona: { seat: stub.player, name: `seat ${stub.player}`, blurb: "" }, decisionStub: stub, legalTargets: legal };
  const prompt = players.buildDecisionPrompt(ctx, target);
  const canonical = encodeDecision({ ...stub, target });
  let text = null;
  for (let attempt = 0; attempt < 3 && text === null; attempt++) {
    try { ({ text } = await provider.complete(prompt)); }      // NO opts — mirrors the real match path
    catch (e) { console.warn(`  [retry] ${label}: ${e.message}`); await sleep(7000); }
  }
  const ok = text === canonical;
  ok ? pass++ : fail++;
  console.log(`\n${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`  want: ${JSON.stringify(canonical)}`);
  console.log(`  got:  ${JSON.stringify(text)}`);
}
console.log(`\n=== ${pass} pass / ${fail} fail (of ${scenarios.length}) ===`);
