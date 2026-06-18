import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// 0G Chain testnet config. RPC URL + chainId + deployer key come from env.
// See myTasks.md to obtain these. Do NOT hardcode the private key.
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai";
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    zeroG: {
      url: ZEROG_RPC_URL,
      chainId: 16602,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
  // Settlement-heavy tests can race the one-time cold Solidity compile on a fresh run;
  // a generous timeout keeps the suite green from a clean checkout (not just warm cache).
  mocha: { timeout: 120000 },
};

export default config;
