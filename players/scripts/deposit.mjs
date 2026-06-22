// One-off: top up the 0G Compute ledger so the "[Auto-funding] insufficient balance" warnings stop
// and a long match can't stall mid-run. Mirrors the broker setup in players/src/zerog.ts.
//   node --env-file=.env players/scripts/deposit.mjs [amount]
import { JsonRpcProvider, Wallet, formatEther } from "ethers";
import { createZGComputeNetworkBroker } from "@0gfoundation/0g-compute-ts-sdk";

const KEY = process.env.COMPUTE_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY;
const RPC = process.env.COMPUTE_RPC_URL ?? process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
if (!KEY) throw new Error("need COMPUTE_PRIVATE_KEY in .env");
const AMOUNT = Number(process.argv[2] ?? 1);

const wallet = new Wallet(KEY, new JsonRpcProvider(RPC, 16602));
console.log(`wallet ${wallet.address}`);
console.log(`on-chain balance: ${formatEther(await wallet.provider.getBalance(wallet.address))} 0G`);

const broker = await createZGComputeNetworkBroker(wallet);

const before = await broker.ledger.getLedger().catch(() => null);
if (before) console.log(`ledger before: ${JSON.stringify(before, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);

console.log(`depositing ${AMOUNT} 0G into the compute ledger…`);
await broker.ledger.depositFund(AMOUNT);

const after = await broker.ledger.getLedger();
console.log(`ledger after: ${JSON.stringify(after, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
console.log("done.");
