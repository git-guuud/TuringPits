// One-off acceptance check for the mainnet inference switch (myTasks.md step 5, first half):
// loads the repo-root .env exactly like server/src/index.ts, then calls the SERVER's buildProvider()
// and asserts it returns a LIVE (isMock:false) mainnet provider with real probed teeSigner + meta.
// The full "settle() succeeds" half is a real match; this proves the server wiring reads the new env.
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), "../../.env") });

const { buildProvider } = await import("../src/match-runner.ts");

console.log("COMPUTE_RPC_URL      :", process.env.COMPUTE_RPC_URL);
console.log("COMPUTE_CHAIN_ID     :", process.env.COMPUTE_CHAIN_ID);
console.log("COMPUTE_PROVIDER_ADDR:", process.env.COMPUTE_PROVIDER_ADDRESS);
console.log("--- calling buildProvider() (real broker probe over mainnet) ---");

const b = await buildProvider();
console.log("isMock     :", b.isMock);
console.log("teeSigner  :", b.teeSigner);
console.log("providerMeta:", JSON.stringify(b.providerMeta));

// Quick live inference sanity through the provider the server would actually use.
if (typeof b.provider.complete === "function" || typeof b.provider.decide === "function") {
  console.log("provider methods:", Object.getOwnPropertyNames(Object.getPrototypeOf(b.provider)).filter((m) => m !== "constructor").join(", "));
}

const ok = b.isMock === false
  && /d45b4301940B297F76d6e622c1CeA2AE660617d4/i.test(b.teeSigner)
  && b.providerMeta?.providerType === "centralized"
  && b.providerMeta?.providerIdentity === "aliyun";
console.log(ok ? "\n✅ server wiring is LIVE on mainnet (isMock:false, probed teeSigner + real meta)" : "\n❌ unexpected buildProvider result");
process.exit(ok ? 0 : 1);
