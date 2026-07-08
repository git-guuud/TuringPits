// Lists every inference service (provider + model) registered on a 0G network, read-only.
//   Testnet (default):  node --env-file=.env players/scripts/list-models.mjs
//   Mainnet:            COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//                         node --env-file=.env players/scripts/list-models.mjs
// listService is a read-only chain call, so the wallet needs NO funds — it works for probing
// mainnet providers/models before funding the Compute ledger (MOVEOVER.md Step 0 prep).
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

// COMPUTE_* wins so this can point at mainnet while the rest of .env stays on testnet.
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const CHAIN_ID = Number(process.env.COMPUTE_CHAIN_ID ?? process.env.ZEROG_CHAIN_ID ?? 16602);
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
if (!KEY) throw new Error("need COMPUTE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env to read the chain");

const broker = await createZGComputeNetworkBroker(new Wallet(KEY, new JsonRpcProvider(RPC, CHAIN_ID)));
const services = await broker.inference.listService();

console.log(`\n0G inference services @ ${RPC} (chainId ${CHAIN_ID}): ${services.length}\n`);
const per1m = (price) => `${formatEther((price ?? 0n) * 1_000_000n)} 0G / 1M tokens`;
for (const s of services) {
  console.log(`• model:        ${s.model}`);
  console.log(`  provider:     ${s.provider}`);
  console.log(`  url:          ${s.url}`);
  console.log(`  verifiability:${s.verifiability || "(none)"}   tee signer: ${s.teeSignerAddress}`);
  console.log(`  price in/out: ${per1m(s.inputPrice)}  /  ${per1m(s.outputPrice)}`);
  if (s.additionalInfo) console.log(`  info:         ${s.additionalInfo}`);
  console.log();
}

// Compact summary of distinct model names.
const models = [...new Set(services.map((s) => s.model).filter(Boolean))];
console.log(`Distinct models (${models.length}): ${models.join(", ")}`);
