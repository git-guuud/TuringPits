import { ethers, network } from "hardhat";

/**
 * Deploys the EIP-2771 Forwarder (gas relayer trust anchor) + MockBetToken (CHIP betting currency)
 * + MafiaMarket, all wired together. Deploy order matters: Forwarder first, since the token and
 * market take its address as their immutable `trustedForwarder`.
 * Usage: npx hardhat run scripts/deploy.ts --network zeroG
 *
 * Reuse an already-deployed Forwarder via FORWARDER_ADDRESS to keep relayer config stable.
 * Reuse an already-deployed token via BET_TOKEN_ADDRESS to keep balances; otherwise a fresh
 * MockBetToken is deployed. The market's bet token is immutable, so a new market needs a token.
 *
 * NOTE: gasless faucet()/approve() require a *fresh* 2771-aware MockBetToken — an old CHIP token
 * (pre-relayer, no trustedForwarder) can't be relayed, so reusing BET_TOKEN_ADDRESS forfeits the
 * gasless mint/approve path. Deploy a fresh token when you want full gasless participation.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "0G");
  console.log("Network:", network.name);

  let forwarderAddress = process.env.FORWARDER_ADDRESS ?? "";
  if (forwarderAddress) {
    console.log("Reusing existing Forwarder:", forwarderAddress);
  } else {
    const Forwarder = await ethers.getContractFactory("Forwarder");
    const forwarder = await Forwarder.deploy();
    await forwarder.waitForDeployment();
    forwarderAddress = await forwarder.getAddress();
    console.log(`Forwarder (EIP-2771 gas relayer) deployed to: ${forwarderAddress}`);
  }

  let tokenAddress = process.env.BET_TOKEN_ADDRESS ?? "";
  if (tokenAddress) {
    console.log("Reusing existing MockBetToken:", tokenAddress, "(WARN: gasless faucet/approve only work on a fresh 2771-aware token)");
  } else {
    const MockBetToken = await ethers.getContractFactory("MockBetToken");
    const token = await MockBetToken.deploy(forwarderAddress);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`MockBetToken (CHIP) deployed to: ${tokenAddress}`);
  }

  const treasury = process.env.PROTOCOL_TREASURY ?? deployer.address;
  const MafiaMarket = await ethers.getContractFactory("MafiaMarket");
  const market = await MafiaMarket.deploy(treasury, tokenAddress, forwarderAddress);
  await market.waitForDeployment();

  const address = await market.getAddress();
  console.log(`MafiaMarket deployed to: ${address}`);
  console.log("Bet token:", tokenAddress);
  console.log("Forwarder:", forwarderAddress);
  console.log("Treasury:", treasury);
  console.log("\nEnv to set → server: FORWARDER_ADDRESS, MAFIA_MARKET_ADDRESS, RELAYER_PRIVATE_KEY (funded)");
  console.log("           → frontend: VITE_MARKET_ADDRESS, VITE_FORWARDER_ADDRESS");

  const postBalance = await ethers.provider.getBalance(deployer.address);
  console.log("Remaining balance:", ethers.formatEther(postBalance), "0G");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
