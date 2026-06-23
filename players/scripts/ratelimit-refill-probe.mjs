// Decisive test: is x-ratelimit-remaining-tokens a RATE BUCKET (drains per-token, refills over idle
// time) or just the model's CONTEXT/OUTPUT limit (per-request, stateless)? Two discriminators:
//   (A) charge ∝ prompt SIZE: a tiny prompt should drain far less than a big one.
//   (B) IDLE REFILL: with NO requests, the remaining count must CLIMB over wall-clock (a context
//       window cannot do this). Run with the server OFF.
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); } catch { await broker.ledger.addLedger(3); }
const st = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!st.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

async function call(prompt) {
  const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt);
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  await res.text();
  return {
    status: res.status,
    remTok: Number(res.headers.get("x-ratelimit-remaining-tokens")),
    limTok: res.headers.get("x-ratelimit-limit-tokens"),
    remReq: res.headers.get("x-ratelimit-remaining-requests"),
  };
}
const TINY = "Reply with one word.";                                             // ~10 tokens
const BIG = "Filler context to inflate the request token count. ".repeat(300);  // ~2k tokens

console.log(`limit-tokens header (the supposed cap): seen on each 200 below\n`);

// (A) charge ∝ size: tiny vs big drain.
console.log("=== (A) does the charge depend on PROMPT SIZE? ===");
let a = await call(TINY); console.log(`  after TINY prompt : remaining=${a.remTok}`);
let b = await call(TINY); console.log(`  after TINY prompt : remaining=${b.remTok}   (tiny drain = ${a.remTok - b.remTok})`);
let c = await call(BIG);  console.log(`  after BIG  prompt : remaining=${c.remTok}   (big  drain = ${b.remTok - c.remTok})`);
let d = await call(BIG);  console.log(`  after BIG  prompt : remaining=${d.remTok}   (big  drain = ${c.remTok - d.remTok})`);
console.log("  → if big-drain >> tiny-drain, it charges actual tokens (rate bucket), not a flat context slot.\n");

// (B) idle refill: record, sleep WITHOUT any request, re-read. Context can't climb; a rate bucket must.
console.log("=== (B) does it REFILL while idle (no requests)? ===");
let r0 = await call(TINY); const t0 = now();
console.log(`  T+0s    remaining=${r0.remTok}`);
for (const wait of [60, 60]) {
  await sleep(wait * 1000);
  const r = await call(TINY); const dt = (now() - t0) / 1000;
  const climbedSinceStart = r.remTok - r0.remTok; // net of the tiny calls' own small charges
  console.log(`  T+${Math.round(dt)}s  remaining=${r.remTok}   (net change since T+0 = ${climbedSinceStart >= 0 ? "+" : ""}${climbedSinceStart}, implies refill ≈ ${Math.round((climbedSinceStart / dt) * 60)}/min before tiny-call charges)`);
}
console.log("\n  VERDICT: if remaining CLIMBED during the idle waits, it is a refilling RATE bucket,");
console.log("           not the model's context/output window (which is per-request and cannot refill).");
