// Confirm the REAL 0G inference rate limit from the wire: dump every response header (esp.
// x-ratelimit-*), then provoke a token-rate 429 and dump its headers + body. The endpoint is the
// one 0G itself resolves via getServiceMetadata, so whatever it returns is 0G's, not another API.
// Run (server OFF so the limit is free): node --env-file=.env players/scripts/ratelimit-headers-probe.mjs
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
if (!KEY || !PROVIDER) { console.error("missing COMPUTE_PRIVATE_KEY / COMPUTE_PROVIDER_ADDRESS in .env"); process.exit(1); }

const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); } catch { await broker.ledger.addLedger(3); }
const st = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!st.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log("0G-resolved endpoint:", endpoint);
console.log("model:", model);

async function call(prompt) {
  const headers = await broker.inference.getRequestHeaders(PROVIDER, prompt);
  const res = await fetch(`${endpoint}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
  });
  const body = await res.text();
  return { res, body };
}
const RL = /ratelimit|rate.?limit|retry.?after|x-rate|tokens?|requests?|quota|\blimit\b|reset|remaining/i;
const rlHeaders = (res) => [...res.headers.entries()].filter(([k]) => RL.test(k));

// 1) baseline small call: print ALL headers so we can see whether a rate-limit header exists at all.
{
  const { res } = await call("Reply with exactly one short word.");
  console.log(`\n=== ALL response headers (small call, status ${res.status}) ===`);
  for (const [k, v] of res.headers.entries()) console.log(`  ${k}: ${v}`);
  const rl = rlHeaders(res);
  console.log("  → rate-limit-ish headers:", rl.length ? JSON.stringify(Object.fromEntries(rl)) : "NONE");
}

// 2) fire LARGE prompts back-to-back to cross any token/min budget and capture the 429 headers+body.
const big = "This is filler context to inflate the token count of the request. ".repeat(300); // ~2k tokens
console.log(`\n=== draining the token burst bucket until a 429, to find the real boundary ===`);
let first429 = false;
for (let i = 1; i <= 30; i++) {
  const { res, body } = await call(`${big}(call ${i})`);
  const h = Object.fromEntries(rlHeaders(res));
  console.log(`[#${i}] status ${res.status}  remaining-tokens=${h["x-ratelimit-remaining-tokens"]} remaining-requests=${h["x-ratelimit-remaining-requests"]} reset-tokens=${h["x-ratelimit-reset-tokens"]}`);
  if (res.status !== 200 && !first429) {
    first429 = true;
    console.log("\n  >>> FIRST 429 — full headers + body <<<");
    console.log("  ALL headers:", JSON.stringify(Object.fromEntries([...res.headers.entries()]), null, 2));
    console.log("  body:", body.slice(0, 400));
    break; // stop once we've captured the boundary
  }
}
console.log("\nDONE. limit-tokens header = sustained refill/min; remaining-tokens at the 429 = burst capacity used up.");
