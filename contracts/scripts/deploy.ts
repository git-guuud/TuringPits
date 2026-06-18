import { ethers, network } from "hardhat";

/**
 * Deploys MafiaMarket to the configured network.
 * Usage: npx hardhat run scripts/deploy.ts --network zeroG
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  console.log("Network:", network.name);

  const MafiaMarket = await ethers.getContractFactory("MafiaMarket");
  const market = await MafiaMarket.deploy();
  await market.waitForDeployment();

  const address = await market.getAddress();
  console.log(`MafiaMarket deployed to: ${address}`);

  const postBalance = await ethers.provider.getBalance(deployer.address);
  console.log("Remaining balance:", ethers.formatEther(postBalance), "0G");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
