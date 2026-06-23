// Minimal: one inference call, print the assigned rate-limit quota from the response headers.
import { JsonRpcProvider, Wallet } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;

const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
const broker = await createZGComputeNetworkBroker(wallet);
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
const headers = await broker.inference.getRequestHeaders(PROVIDER, "Reply with one word.");
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with one word." }] }),
});
await res.text();
console.log("status:", res.status, "(was, pre-deposit: limit-tokens=2000, bucket-cap=32768, limit-requests=10)\n");
console.log("  x-ratelimit-limit-tokens     :", res.headers.get("x-ratelimit-limit-tokens"));
console.log("  x-ratelimit-remaining-tokens :", res.headers.get("x-ratelimit-remaining-tokens"));
console.log("  x-ratelimit-limit-requests   :", res.headers.get("x-ratelimit-limit-requests"));
console.log("  x-ratelimit-remaining-requests:", res.headers.get("x-ratelimit-remaining-requests"));
