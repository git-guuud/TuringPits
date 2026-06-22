import { ethers, network } from "hardhat";

/**
 * Deploys the MockBetToken (CHIP betting currency) + MafiaMarket bound to it.
 * Usage: npx hardhat run scripts/deploy.ts --network zeroG
 *
 * Reuse an already-deployed token via BET_TOKEN_ADDRESS to keep balances; otherwise a fresh
 * MockBetToken is deployed. The market's bet token is immutable, so a new market needs a token.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  console.log("Network:", network.name);

  let tokenAddress = process.env.BET_TOKEN_ADDRESS ?? "";
  if (tokenAddress) {
    console.log("Reusing existing MockBetToken:", tokenAddress);
  } else {
    const MockBetToken = await ethers.getContractFactory("MockBetToken");
    const token = await MockBetToken.deploy();
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`MockBetToken (CHIP) deployed to: ${tokenAddress}`);
  }

  const treasury = process.env.PROTOCOL_TREASURY ?? deployer.address;
  const MafiaMarket = await ethers.getContractFactory("MafiaMarket");
  const market = await MafiaMarket.deploy(treasury, tokenAddress);
  await market.waitForDeployment();

  const address = await market.getAddress();
  console.log(`MafiaMarket deployed to: ${address}`);
  console.log("Bet token:", tokenAddress);
  console.log("Treasury:", treasury);

  const postBalance = await ethers.provider.getBalance(deployer.address);
  console.log("Remaining balance:", ethers.formatEther(postBalance), "0G");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
