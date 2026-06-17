import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

// 0G Chain testnet config. RPC URL + chainId + deployer key come from env.
// See myTasks.md to obtain these. Do NOT hardcode the private key.
const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL ?? "";
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    zeroG: {
      url: ZEROG_RPC_URL,
      // TODO(myTasks): confirm 0G testnet chainId.
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};

export default config;
