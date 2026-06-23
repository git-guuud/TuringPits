// Minimal CJS Hardhat config for deploying to 0G (avoids the broken ESM toolbox/verify tree).
// See memory hardhat-test-run-workaround. Run with Node 18 + local hardhat bin.
require("@nomicfoundation/hardhat-ethers");

const ZEROG_RPC_URL = process.env.ZEROG_RPC_URL || "https://evmrpc-testnet.0g.ai";
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    zeroG: {
      url: ZEROG_RPC_URL,
      chainId: 16602,
      accounts: DEPLOYER_KEY ? [DEPLOYER_KEY] : [],
    },
  },
};
