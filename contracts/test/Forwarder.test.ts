import { expect } from "chai";
import { ethers } from "hardhat";
import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { MaxUint256, type Wallet, type Contract } from "ethers";
import { defaultSchedule, createParams, deployMarket, buildSettlement } from "./helpers/market";

const SEED = "0x" + "ab".repeat(32); // buildSettlement(SEED, 5) → Mafia (YES) wins
const CID = "0x" + "cd".repeat(32);

/**
 * EIP-2771 gas-relayer tests. The "user" is a fresh random wallet with ZERO native 0G — it never
 * sends a transaction. It only signs ForwardRequests; a separate funded "relayer" Hardhat signer
 * submits forwarder.execute() and pays gas. We assert the on-chain effect is attributed to the USER
 * (their CHIP balance, their stake, their claim), never the relayer — the whole point of the relayer.
 */

type Req = {
  from: string; to: string; value: bigint; gas: bigint; nonce: bigint; deadline: bigint; data: string;
};

const TYPES = {
  ForwardRequest: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "gas", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint48" },
    { name: "data", type: "bytes" },
  ],
};

async function domain(forwarder: Contract) {
  const net = await ethers.provider.getNetwork();
  return { name: "TuringPitsForwarder", version: "1", chainId: net.chainId, verifyingContract: await forwarder.getAddress() };
}

/** Build a ForwardRequest for `user` calling `to` with `data`, using the current on-chain nonce. */
async function build(forwarder: Contract, user: Wallet, to: string, data: string, overrides: Partial<Req> = {}): Promise<Req> {
  const latest = await ethers.provider.getBlock("latest");
  return {
    from: user.address,
    to,
    value: 0n,
    gas: 700_000n,
    nonce: (await forwarder.getNonce(user.address)) as bigint,
    deadline: BigInt(latest!.timestamp) + 3600n,
    data,
    ...overrides,
  };
}

async function sign(forwarder: Contract, user: Wallet, req: Req): Promise<string> {
  return user.signTypedData(await domain(forwarder), TYPES, req);
}

/** End-to-end relay: build + sign as `user`, submit via `relayer`. */
async function relay(forwarder: Contract, relayer: any, user: Wallet, to: string, data: string, overrides: Partial<Req> = {}) {
  const req = await build(forwarder, user, to, data, overrides);
  const sig = await sign(forwarder, user, req);
  return forwarder.connect(relayer).execute(req, sig);
}

describe("Forwarder — EIP-2771 gas relayer", () => {
  async function setup() {
    const [owner, treasury, relayer, bob] = await ethers.getSigners();
    const { market, token, forwarder } = await deployMarket(owner, treasury);
    const user = ethers.Wallet.createRandom(); // fresh wallet, ZERO native 0G — only ever signs
    return { owner, treasury, relayer, bob, market, token, forwarder, user };
  }

  it("a relayed faucet() mints CHIP to the USER, not the relayer", async () => {
    const { forwarder, token, relayer, user } = await setup();
    const data = token.interface.encodeFunctionData("faucet", []);
    await relay(forwarder, relayer, user, await token.getAddress(), data);

    expect(await token.balanceOf(user.address)).to.equal(await token.FAUCET_AMOUNT());
    expect(await token.balanceOf(relayer.address)).to.equal(0n);
    expect(await forwarder.getNonce(user.address)).to.equal(1n); // nonce bumped
  });

  it("a relayed approve() sets the USER's allowance", async () => {
    const { forwarder, token, market, relayer, user } = await setup();
    const marketAddr = await market.getAddress();
    const data = token.interface.encodeFunctionData("approve", [marketAddr, MaxUint256]);
    await relay(forwarder, relayer, user, await token.getAddress(), data);

    expect(await token.allowance(user.address, marketAddr)).to.equal(MaxUint256);
  });

  it("a fully-relayed user (0 native 0G) can faucet → approve → bet, with the stake under the USER", async () => {
    const { forwarder, token, market, relayer, user } = await setup();
    const tokenAddr = await token.getAddress();
    const marketAddr = await market.getAddress();

    // Owner opens a match.
    const teeSigner = ethers.Wallet.createRandom();
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: "0x" + "aa".repeat(32), teeSigner: teeSigner.address, nonce: "relay-1", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);

    // User does EVERYTHING via the relayer — three signed requests, zero user gas.
    await relay(forwarder, relayer, user, tokenAddr, token.interface.encodeFunctionData("faucet", []));
    await relay(forwarder, relayer, user, tokenAddr, token.interface.encodeFunctionData("approve", [marketAddr, MaxUint256]));
    await relay(forwarder, relayer, user, marketAddr, market.interface.encodeFunctionData("betYes", [0, ethers.parseEther("2")]));

    expect(await market.stakeYes(0, user.address)).to.equal(ethers.parseEther("2"));
    expect(await market.stakeYes(0, relayer.address)).to.equal(0n);
    expect((await market.matches(0)).poolYes).to.equal(ethers.parseEther("2"));
    // The user never paid gas; the relayer wallet did.
    expect(await ethers.provider.getBalance(user.address)).to.equal(0n);
  });

  it("a relayed claim() pays the USER their winnings from a settled match", async () => {
    const { forwarder, token, market, relayer, bob, user } = await setup();
    const tokenAddr = await token.getAddress();
    const marketAddr = await market.getAddress();

    const teeSigner = ethers.Wallet.createRandom();
    const fx = await buildSettlement(SEED, 5, "relay-claim", teeSigner);
    expect(fx.mafiaWins).to.equal(true); // sanity: YES is the winning side for this seed
    const sched = await defaultSchedule(ethers.provider);
    await market.createMatch(createParams({ roleCommit: fx.commit, teeSigner: teeSigner.address, nonce: "relay-claim", playerCount: 5, schedule: sched }));
    await mineUpTo(sched.bettingOpenBlock);

    // User bets the winning side via relay; bob seeds the losing pool directly (so there's a pot).
    await relay(forwarder, relayer, user, tokenAddr, token.interface.encodeFunctionData("faucet", []));
    await relay(forwarder, relayer, user, tokenAddr, token.interface.encodeFunctionData("approve", [marketAddr, MaxUint256]));
    await relay(forwarder, relayer, user, marketAddr, market.interface.encodeFunctionData("betYes", [0, ethers.parseEther("1")]));
    await token.connect(bob).faucet();
    await token.connect(bob).approve(marketAddr, MaxUint256);
    await market.connect(bob).betNo(0, ethers.parseEther("3"));

    await market.settle(0, fx.moves, fx.roles, fx.salt, CID);
    expect((await market.matches(0)).outcome).to.equal(1); // Yes

    const before = await token.balanceOf(user.address);
    await relay(forwarder, relayer, user, marketAddr, market.interface.encodeFunctionData("claim", [0]));
    const after = await token.balanceOf(user.address);
    // gross 4 CHIP − 2% fee = 3.92, winning pool = 1 → full 3.92 to the lone YES backer.
    expect(after - before).to.equal(ethers.parseEther("3.92"));
    expect(await market.claimed(0, user.address)).to.equal(true);
    expect(await ethers.provider.getBalance(user.address)).to.equal(0n); // still never paid gas
  });

  it("rejects a replayed request (nonce already used)", async () => {
    const { forwarder, token, relayer, user } = await setup();
    const data = token.interface.encodeFunctionData("faucet", []);
    const req = await build(forwarder, user, await token.getAddress(), data);
    const sig = await sign(forwarder, user, req);
    await forwarder.connect(relayer).execute(req, sig); // first use OK
    await expect(forwarder.connect(relayer).execute(req, sig)).to.be.revertedWith("bad nonce");
  });

  it("rejects an expired request (past deadline)", async () => {
    const { forwarder, token, relayer, user } = await setup();
    const data = token.interface.encodeFunctionData("faucet", []);
    const latest = await ethers.provider.getBlock("latest");
    const req = await build(forwarder, user, await token.getAddress(), data, { deadline: BigInt(latest!.timestamp) - 1n });
    const sig = await sign(forwarder, user, req);
    await expect(forwarder.connect(relayer).execute(req, sig)).to.be.revertedWith("request expired");
  });

  it("rejects a tampered request (signature over different data)", async () => {
    const { forwarder, token, market, relayer, user } = await setup();
    const req = await build(forwarder, user, await token.getAddress(), token.interface.encodeFunctionData("faucet", []));
    const sig = await sign(forwarder, user, req);
    // Submit a different `to` than what was signed.
    const tampered = { ...req, to: await market.getAddress() };
    await expect(forwarder.connect(relayer).execute(tampered, sig)).to.be.revertedWith("bad signature");
  });

  it("rejects a signature from someone other than `from`", async () => {
    const { forwarder, token, relayer, user } = await setup();
    const imposter = ethers.Wallet.createRandom();
    const req = await build(forwarder, user, await token.getAddress(), token.interface.encodeFunctionData("faucet", []));
    const sig = await sign(forwarder, imposter, req); // imposter signs a req that claims from = user
    await expect(forwarder.connect(relayer).execute(req, sig)).to.be.revertedWith("bad signature");
  });

  it("bubbles up the inner call's revert reason", async () => {
    const { forwarder, market, relayer, user } = await setup();
    // betYes on a non-existent match reverts "not open" inside the market — the forwarder must surface it.
    const data = market.interface.encodeFunctionData("betYes", [999, ethers.parseEther("1")]);
    await expect(relay(forwarder, relayer, user, await market.getAddress(), data)).to.be.revertedWith("not open");
  });

  it("verify() agrees with execute() and is false for a stale nonce", async () => {
    const { forwarder, token, relayer, user } = await setup();
    const data = token.interface.encodeFunctionData("faucet", []);
    const req = await build(forwarder, user, await token.getAddress(), data);
    const sig = await sign(forwarder, user, req);
    expect(await forwarder.verify(req, sig)).to.equal(true);
    await forwarder.connect(relayer).execute(req, sig);
    expect(await forwarder.verify(req, sig)).to.equal(false); // nonce now stale
  });

  it("direct calls are unaffected — they attribute to msg.sender (relayer optional)", async () => {
    const { token, bob } = await setup();
    // A direct faucet() (no forwarder) mints to the caller, exactly as before the relayer existed.
    await token.connect(bob).faucet();
    expect(await token.balanceOf(bob.address)).to.equal(await token.FAUCET_AMOUNT());
  });
});
