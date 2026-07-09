// Safety check: does the CURRENT .env provider (testnet qwen2.5-omni by default) tolerate an unknown
// chat_template_kwargs.enable_thinking without erroring? Determines whether we can pass the flag
// unconditionally or must gate it. Run: node --env-file=.env players/scripts/thinking-compat-probe.mjs
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN = Number(process.env.COMPUTE_CHAIN_ID ?? process.env.ZEROG_CHAIN_ID ?? 16602);
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN));
const broker = await createZGComputeNetworkBroker(wallet);
try { await broker.ledger.getLedger(); } catch { await broker.ledger.addLedger(3); }
const st = await broker.inference.checkProviderSignerStatus(PROVIDER);
if (!st.isAcknowledged) await broker.inference.acknowledgeProviderSigner(PROVIDER);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
console.log(`model: ${model} (chain ${CHAIN})`);

const content = "Reply with the single word: ping";
const headers = await broker.inference.getRequestHeaders(PROVIDER, content);
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content }], chat_template_kwargs: { enable_thinking: false } }),
});
const raw = await res.text();
console.log(`HTTP ${res.status}`);
console.log(res.ok
  ? `OK — tolerated. answer: ${JSON.stringify(JSON.parse(raw).choices?.[0]?.message?.content)}`
  : `ERROR body: ${raw.slice(0, 300)}`);
console.log("=== done ===");
