import { expect } from "chai";
import { ethers } from "hardhat";
import { buildEnvelope, PROVIDER_META } from "./helpers/envelope";

describe("TeeEnvelope", () => {
  async function deploy() {
    const H = await ethers.getContractFactory("TeeEnvelopeHarness");
    return await H.deploy();
  }
  const m = PROVIDER_META;

  it("recovers the signer of a valid envelope", async () => {
    const h = await deploy();
    const signer = ethers.Wallet.createRandom();
    const move = await buildEnvelope(signer, '{"nonce":"x","phase":"night","round":1,"player":0,"action":"kill","target":2}');
    const recovered = await h.recover(
      move.rawResponseBody, move.reqHashHex, m.providerType, m.providerIdentity, m.tlsFingerprint, move.signature,
    );
    expect(recovered).to.equal(signer.address);
  });

  it("recovers a different address when the body is tampered (hash no longer matches)", async () => {
    const h = await deploy();
    const signer = ethers.Wallet.createRandom();
    const move = await buildEnvelope(signer, '{"nonce":"x","phase":"day","round":1,"player":0,"action":"vote","target":1}');
    // Flip one byte of the body -> sha256(res) changes -> envelope differs -> recovered != signer.
    const bytes = ethers.getBytes(move.rawResponseBody);
    bytes[10] ^= 0xff;
    const recovered = await h.recover(
      ethers.hexlify(bytes), move.reqHashHex, m.providerType, m.providerIdentity, m.tlsFingerprint, move.signature,
    );
    expect(recovered).to.not.equal(signer.address);
  });
});
