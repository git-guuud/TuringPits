import { expect } from "chai";
import { ethers } from "hardhat";
import { PROVIDER_META, buildEnvelope } from "./helpers/envelope";
import { buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32);
const NONCE = "market-match-1";

describe("MafiaMarket — happy path", () => {
  async function setup() {
    const [host, alice, bob] = await ethers.getSigners();
    const teeSigner = ethers.Wallet.createRandom();
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(host).deploy();
    const fx = await buildSettlement(SEED, 5, NONCE, teeSigner);
    const m = PROVIDER_META;
    await market.openMarket(fx.commit, teeSigner.address, m.providerType, m.providerIdentity, m.tlsFingerprint, NONCE, 5);
    return { market, host, alice, bob, fx };
  }

  it("openMarket reverts when teeSigner is address(0)", async () => {
    const [host] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(host).deploy();
    const m = PROVIDER_META;
    const commit = "0x" + "aa".repeat(32);
    await expect(
      market.openMarket(commit, ethers.ZeroAddress, m.providerType, m.providerIdentity, m.tlsFingerprint, NONCE, 5)
    ).to.be.revertedWith("zero signer");
  });

  it("placeBet reverts on a freshly-deployed contract (before openMarket)", async () => {
    const [host, alice] = await ethers.getSigners();
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(host).deploy();
    await expect(
      market.connect(alice).placeBet(1, { value: ethers.parseEther("1") })
    ).to.be.revertedWith("market not opened");
  });

  it("open -> bet -> lock -> settle(on-chain winner) -> claim pays pro-rata", async () => {
    const { market, alice, bob, fx } = await setup();
    expect(await market.state()).to.equal(0); // Open

    await market.connect(alice).placeBet(1, { value: ethers.parseEther("1") }); // YES (Mafia)
    await market.connect(bob).placeBet(0, { value: ethers.parseEther("3") });   // NO (Town)
    await market.lockBetting();
    expect(await market.state()).to.equal(1); // Locked

    await market.settle(fx.moves, fx.roles, fx.salt);
    expect(await market.state()).to.equal(2); // Settled
    // On-chain winner equals the engine winner for these decisions.
    expect(await market.winningSide()).to.equal(fx.mafiaWins ? 1 : 0);

    // Winner claims the whole 4 ETH pot (single winning bettor in this fixture's side).
    const winner = fx.mafiaWins ? alice : bob;
    const before = await ethers.provider.getBalance(winner.address);
    const tx = await market.connect(winner).claim();
    const rcpt = await tx.wait();
    const gas = rcpt!.gasUsed * rcpt!.gasPrice;
    const after = await ethers.provider.getBalance(winner.address);
    expect(after - before + gas).to.equal(ethers.parseEther("4"));
  });
});

describe("MafiaMarket — cheat & guard paths", () => {
  async function setup() {
    const [host] = await ethers.getSigners();
    const teeSigner = ethers.Wallet.createRandom();
    const Market = await ethers.getContractFactory("MafiaMarket");
    const market = await Market.connect(host).deploy();
    const fx = await buildSettlement(SEED, 5, NONCE, teeSigner);
    const m = PROVIDER_META;
    await market.openMarket(fx.commit, teeSigner.address, m.providerType, m.providerIdentity, m.tlsFingerprint, NONCE, 5);
    return { market, host, fx, teeSigner };
  }

  it("reverts settle before lock", async () => {
    const { market, fx } = await setup();
    await expect(market.settle(fx.moves, fx.roles, fx.salt)).to.be.revertedWith("not locked");
  });

  it("reverts a forged signature (signed by the wrong key)", async () => {
    const { market, fx } = await setup();
    await market.lockBetting();
    const attacker = ethers.Wallet.createRandom();
    const env = await buildEnvelope(attacker, '{"nonce":"x","phase":"night","round":1,"player":0,"action":"kill","target":2}');
    const tampered = fx.moves.map((m: any) => ({ ...m }));
    tampered[0] = { decision: fx.moves[0].decision, ...env };
    await expect(market.settle(tampered, fx.roles, fx.salt)).to.be.reverted;
  });

  it("reverts a dropped move (incomplete game)", async () => {
    const { market, fx } = await setup();
    await market.lockBetting();
    const truncated = fx.moves.slice(0, fx.moves.length - 1);
    await expect(market.settle(truncated, fx.roles, fx.salt)).to.be.reverted;
  });

  it("reverts a bad role reveal (tampered roles)", async () => {
    const { market, fx } = await setup();
    await market.lockBetting();
    const badRoles = [...fx.roles];
    badRoles[0] = badRoles[0] === 0 ? 3 : 0; // flip a role
    await expect(market.settle(fx.moves, badRoles, fx.salt)).to.be.revertedWith("role reveal mismatch");
  });

  it("reverts double-claim", async () => {
    const { market, fx } = await setup();
    const [, alice] = await ethers.getSigners();
    await market.connect(alice).placeBet(fx.mafiaWins ? 1 : 0, { value: ethers.parseEther("1") });
    await market.lockBetting();
    await market.settle(fx.moves, fx.roles, fx.salt);
    await market.connect(alice).claim();
    await expect(market.connect(alice).claim()).to.be.revertedWith("already claimed");
  });

  it("reverts a bet after lock", async () => {
    const { market } = await setup();
    await market.lockBetting();
    const [, alice] = await ethers.getSigners();
    await expect(market.connect(alice).placeBet(1, { value: ethers.parseEther("1") })).to.be.revertedWith("betting not open");
  });
});
