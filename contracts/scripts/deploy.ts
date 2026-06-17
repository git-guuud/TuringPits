import { ethers, network } from "hardhat";
import { writeFileSync } from "node:fs";

// Deploys BettingMarket to the configured network (use --network zeroG for 0G testnet).
// Records the address in deployments.local.json (gitignored).
async function main() {
  const Market = await ethers.getContractFactory("BettingMarket");
  const market = await Market.deploy();
  await market.waitForDeployment();
  const address = await market.getAddress();
  console.log(`BettingMarket deployed to ${address} on ${network.name}`);
  writeFileSync(
    "deployments.local.json",
    JSON.stringify({ [network.name]: { BettingMarket: address } }, null, 2),
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
