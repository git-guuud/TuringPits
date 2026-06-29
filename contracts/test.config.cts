// Minimal CJS Hardhat config for RUNNING TESTS (avoids the broken ESM toolbox/verify tree).
// See memory hardhat-test-run-workaround. Run with Node 18 + local hardhat bin:
//   PATH="/usr/bin:$PATH" node_modules/.bin/hardhat test --config test.config.cts
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true },
  },
  networks: {
    hardhat: {
      // Mirror hardhat.config.ts: fund accounts generously so the MAX_BET_PER_TX test can attempt a
      // 10001-ETH bet and have the contract (not the sender) revert it.
      accounts: { count: 10, accountsBalance: "20000000000000000000000" },
    },
  },
  mocha: { timeout: 120000 },
};
