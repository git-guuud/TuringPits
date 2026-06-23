// READ-ONLY: confirm the deposit tx landed + current ledger, then re-read the rate-limit quota to
// see whether funding raised x-ratelimit-limit-tokens. Does NOT deposit again.
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const PROVIDER = process.env.COMPUTE_PROVIDER_ADDRESS ?? process.env.TEE_PROVIDER_ADDRESS;
const TX = "0x2d96478e660e8067006d61c48b005da9ad97fce2674e4544633646c27c490813";

const provider = new JsonRpcProvider(RPC, 16602);
const wallet = new Wallet(KEY, provider);

const rcpt = await provider.getTransactionReceipt(TX);
console.log(`deposit tx ${TX.slice(0, 12)}…`);
console.log("  status:", rcpt ? (rcpt.status === 1 ? "✅ SUCCESS" : "❌ FAILED") : "⏳ PENDING (no receipt yet)", "| block:", rcpt?.blockNumber ?? "-");
console.log("  on-chain wallet balance now:", formatEther(await provider.getBalance(wallet.address)), "0G");

const broker = await createZGComputeNetworkBroker(wallet);
const ledger = await broker.ledger.getLedger();
console.log("  ledger now:", JSON.stringify(ledger, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// Re-read the assigned quota off a real 200 response.
const { endpoint, model } = await broker.inference.getServiceMetadata(PROVIDER);
const headers = await broker.inference.getRequestHeaders(PROVIDER, "Reply with one word.");
const res = await fetch(`${endpoint}/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with one word." }] }),
});
await res.text();
console.log("\nQUOTA AFTER FUNDING (was: limit-tokens=2000, bucket cap=32768, limit-requests=10):");
console.log("  x-ratelimit-limit-tokens     :", res.headers.get("x-ratelimit-limit-tokens"));
console.log("  x-ratelimit-remaining-tokens :", res.headers.get("x-ratelimit-remaining-tokens"));
console.log("  x-ratelimit-limit-requests   :", res.headers.get("x-ratelimit-limit-requests"));
