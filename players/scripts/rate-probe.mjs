// RATE-LIMIT probe: fires a burst of real-sized inference calls at the live 0G provider with the
// throttle DISABLED, to measure the provider's ACTUAL rate limit instead of assuming it.
//
// Why: the match throttle is currently tuned to ~2 calls/min (DEFAULT_TOKENS_PER_MIN=1950 at
// ~900 tokens/call). But whole rounds were observed concluding in <4 min before the throttle
// existed — i.e. >5 calls/min sustained — which is impossible under a true 2000 tok/min rolling
// cap. So either the budget is far too conservative, or the real limit is a burst BUCKET (drains,
// then refills) rather than a per-minute window. This probe distinguishes the two: it fires N
// calls as fast as the network allows and reports, per call, the latency and whether a 429 hit
// (and the provider's exact "wait N seconds" hint, which `complete`'s onRetry logs).
//
//   node --env-file=.env players/scripts/rate-probe.mjs [N]
//
// Read the output as:
//   * All N return with low, flat latency → the real limit is far above our throttle: just loosen
//     it. The "effective calls/min" line is the floor of what's actually sustainable.
//   * First K succeed fast, then latency jumps with a "[0g] transient ... 429 ... wait N seconds"
//     retry log → it's a BURST BUCKET of ~K calls; size the throttle to refill, not to a flat /min.
import * as players from "@turingpits/players";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER_ADDR = process.env.TEE_PROVIDER_ADDRESS ?? process.env.COMPUTE_PROVIDER_ADDRESS;
const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY || !PROVIDER_ADDR) throw new Error("need COMPUTE_PRIVATE_KEY + TEE_PROVIDER_ADDRESS/COMPUTE_PROVIDER_ADDRESS in .env");

const N = Math.max(1, Number(process.argv[2] ?? 16)); // ~a full round's worth of calls by default

// A realistic decision prompt (the smallest real call) — we want the PROVIDER's rate behaviour,
// not a synthetic tiny prompt, so token-cost matches a real match turn.
const NONCE = "rate-probe";
const ctx = {
  persona: { seat: 2, name: "seat 2", blurb: "" },
  role: "TOWN", alive: [0, 1, 2, 3, 4], roster: null, transcript: [], deaths: [],
  decisionStub: { nonce: NONCE, phase: "day", round: 2, player: 2, action: "vote" },
  legalTargets: [0, 1, 3, 4],
};
const prompt = players.buildDecisionPrompt(ctx, 3);
const estTokens = players.estimateCallTokens(prompt);

// Throttle DISABLED: minRequestIntervalMs ~0 and an enormous token budget, so the provider's OWN
// rate limit is the only thing pacing the burst. The 429 wait-hint backoff still runs (we WANT to
// see those logs) but never fires unless the provider actually rate-limits us.
const provider = await players.createZeroGDirectProvider({
  privateKey: KEY,
  rpcUrl: RPC,
  providerAddress: PROVIDER_ADDR,
  minRequestIntervalMs: 1,
  tokensPerMin: 100_000_000,
});

console.log(`prompt ≈ ${prompt.length} chars, est ${estTokens} tokens/call; firing ${N} back-to-back calls (throttle off)\n`);

const t0 = Date.now();
const lats = [];
for (let i = 0; i < N; i++) {
  const s = Date.now();
  let ok = true;
  try {
    await provider.complete(prompt); // NO opts — mirrors the real decision call
  } catch (e) {
    ok = false;
    console.warn(`  call ${i + 1}: FAILED after retries — ${e.message ?? e}`);
  }
  const dt = Date.now() - s;
  lats.push(dt);
  console.log(`  call ${i + 1}: ${ok ? "ok" : "FAIL"}  ${dt}ms  (t+${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

const totalS = (Date.now() - t0) / 1000;
const perMin = (N / totalS) * 60;
console.log(`\n=== ${N} calls in ${totalS.toFixed(1)}s → ${perMin.toFixed(1)} calls/min effective ===`);
console.log(`tokens shipped ≈ ${N * estTokens} over ${totalS.toFixed(1)}s → ${((N * estTokens) / totalS * 60).toFixed(0)} tok/min effective`);
console.log(`(a "wait N seconds" retry log above marks where the provider actually rate-limited; flat low latencies mean the throttle is over-conservative)`);
