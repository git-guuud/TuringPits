// Focused live check: does the weak 0G model emit the merged day-vote format (TARGET: / CASE:)
// reliably, and does parseVoteSpeech recover a legal target + a clean case? ~3 calls, no settlement.
// Run: npm run build (in players/) then: node --env-file=.env players/scripts/merge-probe.mjs
import { buildVoteSpeechPrompt } from "@turingpits/players/dist/prompt.js";
import { parseVoteSpeech as pvs } from "@turingpits/players/dist/reason.js";
import * as players from "@turingpits/players";

const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const base = await players.createZeroGDirectProvider({ privateKey: KEY, rpcUrl: RPC, providerAddress: PROVIDER_ADDR });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const complete = async (p, o) => {
  for (let a = 0; ; a++) {
    try { return await base.complete(p, o); }
    catch (e) { const m = [e?.message, e?.code].filter(Boolean).join(" ") || String(e);
      if (/429|fetch failed|ETIMEDOUT|timeout|auto-funding|50[234]/i.test(m) && a < 15) { await sleep(/429/.test(m) ? 30000 : 10000); continue; } throw e; } }
};

const roster = [
  { seat: 0, name: "Ada", blurb: "a cold vote-counter; clipped, math-first, no warmth" },
  { seat: 1, name: "Boris", blurb: "a loud brawler; first to accuse, swings hard and fast" },
  { seat: 2, name: "Cleo", blurb: "a silver-tongued peacemaker who slows every rush to vote" },
  { seat: 3, name: "Dmitri", blurb: "a sardonic contrarian who distrusts the obvious read" },
  { seat: 4, name: "Esme", blurb: "a patient strategist who speaks rarely but lands hard" },
];
const transcript = [
  [0, "Boris jumped on the first name without a reason. That reads as cover to me."],
  [1, "I'm direct, not guilty. Ada, you've said nothing concrete all day."],
  [3, "Both of you are loud. I'd rather hear who Cleo trusts."],
];
// Three different actors/roles so we sample the format across personas.
const cases = [
  { persona: roster[0], role: "TOWN", legalTargets: [1, 2, 3, 4] },
  { persona: roster[4], role: "DETECTIVE", legalTargets: [0, 1, 2, 3], investigations: [{ round: 1, target: 1, faction: "MAFIA" }] },
  { persona: roster[2], role: "MAFIA", teammates: [3], legalTargets: [0, 1, 4] },
];

let ok = 0;
for (const c of cases) {
  const ctx = {
    persona: c.persona, role: c.role, alive: [0, 1, 2, 3, 4], roster, transcript,
    decisionStub: { nonce: "merge-probe", phase: "day", round: 2, player: c.persona.seat, action: "vote" },
    legalTargets: c.legalTargets, stage: "vote",
    teammates: c.teammates, investigations: c.investigations,
    deaths: [{ round: 1, phase: "night", seat: 5 }],
  };
  const { text } = await complete(buildVoteSpeechPrompt(ctx), { temperature: 0.8, seed: 7 });
  const parsed = pvs(text, ctx.legalTargets);
  const good = parsed && Number.isInteger(parsed.target) && parsed.speech.trim().length > 5;
  if (good) ok++;
  console.log(`\n===== ${c.persona.name} (${c.role}) =====`);
  console.log("RAW:", JSON.stringify(text));
  console.log("PARSED:", parsed ? `target=${parsed.target}  case="${parsed.speech}"` : "NULL (no legal target)");
  console.log("RESULT:", good ? "✅ legal target + clean case in ONE call" : "⚠️ would fall back to a speech call");
}
console.log(`\n==== ${ok}/${cases.length} merged calls yielded target+case directly ====`);
