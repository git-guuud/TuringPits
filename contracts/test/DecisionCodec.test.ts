import { expect } from "chai";
import { ethers } from "hardhat";

describe("DecisionCodec", () => {
  async function deploy() {
    const H = await ethers.getContractFactory("DecisionCodecHarness");
    return await H.deploy();
  }
  // Decision struct order: [phase, round, player, action, target]; Phase Night=0/Day=1; Action Kill=0,Save=1,Investigate=2,Vote=3.

  it("matches engine encodeDecision byte-for-byte (night kill)", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const d = { nonce: "0xabc123", phase: "night" as const, round: 1, player: 0, action: "kill" as const, target: 2 };
    const expected = engine.encodeDecision(d);
    const onchain = await h.encode(d.nonce, { phase: 0, round: 1, player: 0, action: 0, target: 2 });
    expect(onchain).to.equal(expected);
  });

  it("matches engine encodeDecision (day vote, multi-digit round/target)", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const d = { nonce: "match-42", phase: "day" as const, round: 12, player: 3, action: "vote" as const, target: 10 };
    const expected = engine.encodeDecision(d);
    const onchain = await h.encode(d.nonce, { phase: 1, round: 12, player: 3, action: 3, target: 10 });
    expect(onchain).to.equal(expected);
  });

  it("jsonEscape(encode(...)) equals the JSON-escaped decision string the body embeds", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const d = { nonce: "0xabc123", phase: "night" as const, round: 1, player: 0, action: "kill" as const, target: 2 };
    const decisionStr = engine.encodeDecision(d);
    const embedded = JSON.stringify(decisionStr).slice(1, -1); // how it appears as a JSON string value
    const onchain = await h.escapedEncode(d.nonce, { phase: 0, round: 1, player: 0, action: 0, target: 2 });
    expect(onchain).to.equal(embedded);
  });
});
