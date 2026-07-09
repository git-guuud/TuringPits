// Prints the current 0G Compute ledger + wallet balance on mainnet, so per-match spend can be gauged
// by diffing before/after a match. Run: COMPUTE_RPC_URL=https://evmrpc.0g.ai COMPUTE_CHAIN_ID=16661 \
//   node --env-file=.env players/scripts/ledger-balance.mjs
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const RPC = process.env.COMPUTE_RPC_URL ?? "https://evmrpc.0g.ai";
const CHAIN_ID = Number(process.env.COMPUTE_CHAIN_ID ?? 16661);
const wallet = new Wallet(process.env.COMPUTE_PRIVATE_KEY, new JsonRpcProvider(RPC, CHAIN_ID));
const fmt = (v) => `${formatEther(BigInt(v))} 0G`;

const walletBal = await wallet.provider.getBalance(wallet.address);
const broker = await createZGComputeNetworkBroker(wallet);
const l = await broker.ledger.getLedger();

console.log("network      :", RPC, `(chainId ${CHAIN_ID})`);
console.log("wallet       :", wallet.address);
console.log("wallet balance:", formatEther(walletBal), "0G   (native, funds the ledger)");
console.log("\nledger (raw) :", JSON.stringify(l, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
// SDK ledger tuple: [user, availableBalance, totalBalance, ...] — print every numeric field as 0G.
const nums = (Array.isArray(l) ? l : Object.values(l)).filter((v) => typeof v === "bigint" || /^\d{6,}$/.test(String(v)));
console.log("\nledger 0G fields:");
nums.forEach((v, i) => console.log(`  [${i}] ${fmt(v)}`));
