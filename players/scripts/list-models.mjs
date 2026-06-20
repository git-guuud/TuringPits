// Lists every inference service (provider + model) registered on the 0G testnet, read-only.
//   node --env-file=.env players/scripts/list-models.mjs
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
if (!KEY) throw new Error("need COMPUTE_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY) in .env to read the chain");

const broker = await createZGComputeNetworkBroker(new Wallet(KEY, new JsonRpcProvider(RPC, 16602)));
const services = await broker.inference.listService();

console.log(`\n0G testnet inference services: ${services.length}\n`);
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
