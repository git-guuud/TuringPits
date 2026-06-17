import { expect } from "chai";
import { ethers } from "hardhat";

// Day 4 exit criteria live here: full lifecycle happy path + reject double-claim
// and settle-before-lock. Skipped until the contract is implemented.
describe.skip("BettingMarket", () => {
  it("runs open -> bet -> lock -> settle -> claim", async () => {
    const Market = await ethers.getContractFactory("BettingMarket");
    const market = await Market.deploy();
    await market.waitForDeployment();
    expect(await market.state()).to.equal(0); // Open after openMarket
  });
});
