# Day 5 — On-Chain TEE Verifier + Mafia State Machine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy `MafiaMarket.sol` — a parimutuel YES/NO faction-win market whose `settle()` verifies each move's real 0G-TEE envelope signature on-chain, checks the role commit-reveal, and runs the Mafia rules in Solidity to compute the winner.

**Architecture:** One escrow contract (`MafiaMarket`) orchestrates three pure libraries — `DecisionCodec` (reconstructs `engine/src/encoding.ts` byte-for-byte + JSON-escape), `TeeEnvelope` (sha256 precompile → envelope rebuild → EIP-191 → `ecrecover`), `MafiaRules` (a Solidity port of `engine/src/moderator.ts`). Decisions are bound to the signed response body by an offset/slice equality check, avoiding on-chain JSON parsing. Tests use Hardhat on a local chain with real-shaped envelopes signed by a labeled local key.

**Tech Stack:** Solidity 0.8.24, Hardhat 2.22 + `@nomicfoundation/hardhat-toolbox` 5 (ethers v6, chai, mocha, TypeChain), `@turingpits/engine` (ESM, imported via dynamic `import()` in tests).

## Global Constraints

- Solidity `^0.8.24`; optimizer enabled, runs 200 (already in `hardhat.config.ts`).
- `enum Role { MAFIA, DOCTOR, DETECTIVE, TOWN }` — order MUST match `engine/src/commit.ts` `ROLE_ENUM` (MAFIA=0, DOCTOR=1, DETECTIVE=2, TOWN=3).
- The on-chain canonical decision string MUST be byte-identical to `engine/src/encoding.ts` `encodeDecision`: `{"nonce":<json>,"phase":"night|day","round":N,"player":N,"action":"kill|save|investigate|vote","target":N}` — fixed key order, no whitespace.
- The role-commit preimage is `roleBytes (one byte per role, seat order) ++ salt (32 bytes)`, hashed with **SHA-256** (precompile `0x2`) — NOT keccak, NOT `abi.encodePacked(uint8[])` (which would 32-byte-pad each role). Must equal `engine/src/commit.ts` `commitRoles`.
- The TEE signature is EIP-191 `personal_sign` over the ASCII envelope `sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint`, where `sha256(res)` is the lowercase hex of `sha256(rawResponseBody)`.
- Network: 0G Galileo testnet, chainId 16602, RPC `https://evmrpc-testnet.0g.ai`, `DEPLOYER_PRIVATE_KEY` in `.env` (= the funded Compute wallet).
- Mark any unavoidable mock `// MOCK:`. The test signer is a labeled local key; never present it as a real attestation.
- All Hardhat commands run from `contracts/`. The engine must be built first: `npm run build -w @turingpits/engine`.

---

### Task 1: Toolchain, shared types, string utils

**Files:**
- Create: `contracts/tsconfig.json`
- Create: `contracts/contracts/MafiaTypes.sol`
- Create: `contracts/contracts/lib/StrUtils.sol`
- Delete: `contracts/contracts/BettingMarket.sol`, `contracts/test/BettingMarket.test.ts`

**Interfaces:**
- Produces: `enum Role {MAFIA,DOCTOR,DETECTIVE,TOWN}`, `enum Phase {Night,Day}`, `enum Action {Kill,Save,Investigate,Vote}`, `enum Side {No,Yes}`, `struct Decision {Phase phase; uint32 round; uint8 player; Action action; uint8 target;}` (in `MafiaTypes.sol`). `StrUtils.toString(uint256)→string`, `StrUtils.toHex(bytes32)→string` (internal pure).

- [ ] **Step 1: Create `contracts/tsconfig.json`** (CommonJS, so Hardhat's ts-node can load config/tests; the ESM root base breaks it).

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist"
  },
  "include": ["./scripts", "./test", "./hardhat.config.ts"]
}
```

- [ ] **Step 2: Delete the old scaffold**

```bash
cd contracts
rm contracts/BettingMarket.sol test/BettingMarket.test.ts
```

- [ ] **Step 3: Create `contracts/contracts/MafiaTypes.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// Role enum order MUST match engine/src/commit.ts ROLE_ENUM (MAFIA=0..TOWN=3).
enum Role { MAFIA, DOCTOR, DETECTIVE, TOWN }
enum Phase { Night, Day }
enum Action { Kill, Save, Investigate, Vote }
enum Side { No, Yes } // Yes = "Mafia wins"

/// @notice The structured decision the TEE binds and the state machine consumes.
/// @dev `nonce` is match-level (shared by all moves), so it is not stored per-Decision.
struct Decision {
    Phase phase;
    uint32 round;
    uint8 player;
    Action action;
    uint8 target;
}
```

- [ ] **Step 4: Create `contracts/contracts/lib/StrUtils.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library StrUtils {
    /// @dev uint -> decimal string (OZ Strings pattern).
    function toString(uint256 value) internal pure returns (string memory) {
        if (value == 0) return "0";
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) { digits++; temp /= 10; }
        bytes memory buffer = new bytes(digits);
        while (value != 0) { digits -= 1; buffer[digits] = bytes1(uint8(48 + (value % 10))); value /= 10; }
        return string(buffer);
    }

    /// @dev 32 bytes -> 64-char lowercase hex (no 0x), matching node crypto digest("hex").
    function toHex(bytes32 data) internal pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            str[i * 2] = alphabet[uint8(data[i] >> 4)];
            str[i * 2 + 1] = alphabet[uint8(data[i] & 0x0f)];
        }
        return string(str);
    }
}
```

- [ ] **Step 5: Compile**

Run: `cd contracts && npm run build -w @turingpits/engine && npx hardhat compile`
Expected: `Compiled N Solidity files successfully`. (A Node version warning is fine.)

- [ ] **Step 6: Commit**

```bash
git add contracts/tsconfig.json contracts/contracts/MafiaTypes.sol contracts/contracts/lib/StrUtils.sol
git rm contracts/contracts/BettingMarket.sol contracts/test/BettingMarket.test.ts
git commit -m "Day 5: contracts toolchain, shared Mafia types, string utils"
```

---

### Task 2: DecisionCodec — on-chain canonical encoding

**Files:**
- Create: `contracts/contracts/lib/DecisionCodec.sol`
- Create: `contracts/contracts/test/DecisionCodecHarness.sol`
- Test: `contracts/test/DecisionCodec.test.ts`

**Interfaces:**
- Consumes: `MafiaTypes.{Decision,Phase,Action}`, `StrUtils`.
- Produces: `DecisionCodec.encode(string nonce, Decision d) → string` (== `encodeDecision`), `DecisionCodec.jsonEscape(string) → string` (escapes `"`→`\"`, `\`→`\\`). Both `internal pure`.

- [ ] **Step 1: Write the failing test** `contracts/test/DecisionCodec.test.ts`

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd contracts && npx hardhat test test/DecisionCodec.test.ts`
Expected: FAIL — `DecisionCodecHarness` artifact not found.

- [ ] **Step 3: Create `contracts/contracts/lib/DecisionCodec.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "./StrUtils.sol";

/// @dev Reconstructs engine/src/encoding.ts encodeDecision byte-for-byte, plus JSON escaping
///      so the decision can be matched against the (escaped) content inside the signed body.
library DecisionCodec {
    function _phase(Phase p) private pure returns (string memory) {
        return p == Phase.Night ? '"night"' : '"day"';
    }

    function _action(Action a) private pure returns (string memory) {
        if (a == Action.Kill) return '"kill"';
        if (a == Action.Save) return '"save"';
        if (a == Action.Investigate) return '"investigate"';
        return '"vote"';
    }

    /// @dev Escapes the two characters our decision strings can contain that JSON requires
    ///      escaping: `"` -> `\"` and `\` -> `\\`. (No control chars appear.)
    function jsonEscape(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(b.length * 2);
        uint256 j;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == '"' || c == "\\") { out[j++] = "\\"; out[j++] = c; }
            else { out[j++] = c; }
        }
        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) trimmed[i] = out[i];
        return string(trimmed);
    }

    function _jsonString(string memory s) private pure returns (string memory) {
        return string.concat('"', jsonEscape(s), '"');
    }

    /// @notice The canonical decision string == engine encodeDecision(d) with this nonce.
    function encode(string memory nonce, Decision memory d) internal pure returns (string memory) {
        return string.concat(
            '{"nonce":', _jsonString(nonce),
            ',"phase":', _phase(d.phase),
            ',"round":', StrUtils.toString(d.round),
            ',"player":', StrUtils.toString(d.player),
            ',"action":', _action(d.action),
            ',"target":', StrUtils.toString(d.target),
            "}"
        );
    }
}
```

- [ ] **Step 4: Create `contracts/contracts/test/DecisionCodecHarness.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "../lib/DecisionCodec.sol";

contract DecisionCodecHarness {
    function encode(string calldata nonce, Decision calldata d) external pure returns (string memory) {
        return DecisionCodec.encode(nonce, d);
    }

    function escapedEncode(string calldata nonce, Decision calldata d) external pure returns (string memory) {
        return DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, d));
    }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd contracts && npx hardhat test test/DecisionCodec.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 6: Commit**

```bash
git add contracts/contracts/lib/DecisionCodec.sol contracts/contracts/test/DecisionCodecHarness.sol contracts/test/DecisionCodec.test.ts
git commit -m "Day 5: DecisionCodec mirrors engine encodeDecision + JSON escape, cross-checked"
```

---

### Task 3: TeeEnvelope — on-chain envelope signature recovery

**Files:**
- Create: `contracts/contracts/lib/TeeEnvelope.sol`
- Create: `contracts/contracts/test/TeeEnvelopeHarness.sol`
- Create: `contracts/test/helpers/envelope.ts`
- Test: `contracts/test/TeeEnvelope.test.ts`

**Interfaces:**
- Consumes: `StrUtils`.
- Produces: `TeeEnvelope.recover(bytes rawBody, string reqHashHex, string providerType, string providerIdentity, string tlsFp, bytes sig) → address` (`internal pure`). Helper `buildEnvelope(wallet, decisionStr, meta) → {rawResponseBody, contentOffset, contentLen, reqHashHex, signature}` and `PROVIDER_META`.

- [ ] **Step 1: Create the fixture helper `contracts/test/helpers/envelope.ts`**

```ts
import { sha256, toUtf8Bytes, hexlify, type Wallet } from "ethers";

export const PROVIDER_META = {
  providerType: "centralized",
  providerIdentity: "aliyun",
  tlsFingerprint: "sha256/AAAABBBBCCCCDDDDEEEEFFFF0000111122223333=",
};

export interface BuiltMove {
  rawResponseBody: string; // 0x-hex of the UTF-8 body
  contentOffset: number;
  contentLen: number;
  reqHashHex: string;
  signature: string;
}

/**
 * Build a REAL-shaped 0G-TEE envelope over a synthetic OpenAI-JSON body whose
 * choices[0].message.content IS `decisionStr`. Signed EIP-191 by `wallet` (a labeled local
 * key registered as teeSigner). Verification mechanism is real; only the signer is local.
 */
export async function buildEnvelope(
  wallet: Wallet,
  decisionStr: string,
  meta = PROVIDER_META,
): Promise<BuiltMove> {
  const body = JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: decisionStr }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  const bodyBytes = Buffer.from(body, "utf8");

  // The decision appears in the body as a JSON string value (quotes escaped).
  const embedded = JSON.stringify(decisionStr).slice(1, -1);
  const embeddedBytes = Buffer.from(embedded, "utf8");
  const contentOffset = bodyBytes.indexOf(embeddedBytes);
  if (contentOffset < 0) throw new Error("decision content not found in body");
  const contentLen = embeddedBytes.length;

  const resHashHex = sha256(bodyBytes).slice(2); // lowercase hex, no 0x
  // part[0] = sha256(request) is opaque to the contract; any 64-hex is fine for tests.
  const reqHashHex = sha256(toUtf8Bytes("request:" + decisionStr)).slice(2);
  const envelope = `${reqHashHex}:${resHashHex}:${meta.providerType}:${meta.providerIdentity}:${meta.tlsFingerprint}`;
  const signature = await wallet.signMessage(envelope); // EIP-191 personal_sign

  return { rawResponseBody: hexlify(bodyBytes), contentOffset, contentLen, reqHashHex, signature };
}
```

- [ ] **Step 2: Write the failing test** `contracts/test/TeeEnvelope.test.ts`

```ts
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
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd contracts && npx hardhat test test/TeeEnvelope.test.ts`
Expected: FAIL — `TeeEnvelopeHarness` artifact not found.

- [ ] **Step 4: Create `contracts/contracts/lib/TeeEnvelope.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./StrUtils.sol";

/// @dev Reconstructs the live-confirmed 0G-TEE envelope and recovers its EIP-191 signer.
///      Envelope = sha256(req):sha256(res):provider_type:provider_identity:tls_fingerprint,
///      where sha256(res) = lowercase hex of sha256(rawResponseBody).
library TeeEnvelope {
    function recover(
        bytes memory rawResponseBody,
        string memory reqHashHex,
        string memory providerType,
        string memory providerIdentity,
        string memory tlsFingerprint,
        bytes memory signature
    ) internal pure returns (address) {
        string memory resHashHex = StrUtils.toHex(sha256(rawResponseBody));
        string memory envelope = string.concat(
            reqHashHex, ":", resHashHex, ":", providerType, ":", providerIdentity, ":", tlsFingerprint
        );
        bytes32 digest = _ethSignedHash(envelope);
        return _recover(digest, signature);
    }

    function _ethSignedHash(string memory message) private pure returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n", StrUtils.toString(bytes(message).length), message)
        );
    }

    function _recover(bytes32 hash, bytes memory sig) private pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}
```

- [ ] **Step 5: Create `contracts/contracts/test/TeeEnvelopeHarness.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../lib/TeeEnvelope.sol";

contract TeeEnvelopeHarness {
    function recover(
        bytes calldata rawResponseBody,
        string calldata reqHashHex,
        string calldata providerType,
        string calldata providerIdentity,
        string calldata tlsFingerprint,
        bytes calldata signature
    ) external pure returns (address) {
        return TeeEnvelope.recover(rawResponseBody, reqHashHex, providerType, providerIdentity, tlsFingerprint, signature);
    }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd contracts && npx hardhat test test/TeeEnvelope.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 7: Commit**

```bash
git add contracts/contracts/lib/TeeEnvelope.sol contracts/contracts/test/TeeEnvelopeHarness.sol contracts/test/TeeEnvelope.test.ts contracts/test/helpers/envelope.ts
git commit -m "Day 5: TeeEnvelope reconstructs the real 0G envelope and ecrecovers the signer"
```

---

### Task 4: MafiaRules — Solidity port of the moderator

**Files:**
- Create: `contracts/contracts/lib/MafiaRules.sol`
- Create: `contracts/contracts/test/MafiaRulesHarness.sol`
- Create: `contracts/test/helpers/match.ts`
- Test: `contracts/test/MafiaRules.test.ts`

**Interfaces:**
- Consumes: `MafiaTypes.{Role,Phase,Action,Decision}`.
- Produces: `MafiaRules.init(Role[] roles) → Game`, `MafiaRules.applyDecision(Game g, Decision d)` (mutates `g` in memory; reverts on illegal/out-of-order), `Game.over` (bool), `Game.mafiaWins` (bool). Helper `scriptedMatch(seed, n, nonce) → {decisions, mafiaWins}` with `decisions: EngineDecision[]`.

- [ ] **Step 1: Create the match helper `contracts/test/helpers/match.ts`**

```ts
// Drives the engine moderator with a full-knowledge, guaranteed-terminating strategy to
// produce a legal ordered decision list and the engine's winner. Used to cross-check the
// Solidity state machine against engine/src/moderator.ts.
export interface EngineDecision {
  nonce: string;
  phase: "night" | "day";
  round: number;
  player: number;
  action: "kill" | "save" | "investigate" | "vote";
  target: number;
}

const NIGHT_ACTION: Record<string, "kill" | "save" | "investigate" | undefined> = {
  MAFIA: "kill", DOCTOR: "save", DETECTIVE: "investigate",
};

export async function scriptedMatch(
  seed: string, n: number, nonce: string,
): Promise<{ decisions: EngineDecision[]; mafiaWins: boolean }> {
  const engine = await import("@turingpits/engine");
  let state = engine.initState(seed, n, nonce);
  const decisions: EngineDecision[] = [];
  const doctorSeat = state.players.findIndex((p: any) => p.role === "DOCTOR");

  let guard = 0;
  while (engine.winner(state) === null) {
    if (guard++ > 200) throw new Error("scripted match did not terminate");
    const living: number[] = state.players.filter((p: any) => p.alive).map((p: any) => p.id);

    for (const p of state.players) {
      if (!p.alive) continue;
      let action: EngineDecision["action"];
      let target: number;
      if (state.phase === "day") {
        action = "vote";
        target = living.find((id) => id !== p.id)!; // lowest-index living seat != self
      } else {
        const a = NIGHT_ACTION[p.role];
        if (!a) continue;
        action = a;
        if (a === "kill") {
          // highest-index living non-mafia, non-doctor (doctor saves itself) -> kill lands.
          const candidates = state.players
            .filter((q: any) => q.alive && q.role !== "MAFIA" && q.id !== doctorSeat)
            .map((q: any) => q.id);
          target = candidates.length ? candidates[candidates.length - 1] : living.find((id) => id !== p.id)!;
        } else if (a === "save") {
          target = p.id; // doctor saves itself
        } else {
          target = living.find((id) => id !== p.id)!; // detective investigates lowest other
        }
      }
      const d: EngineDecision = { nonce, phase: state.phase, round: state.round, player: p.id, action, target };
      decisions.push(d);
      state = engine.applyDecision(state, d);
      if (engine.winner(state) !== null) break;
    }
  }
  return { decisions, mafiaWins: engine.winner(state) === "MAFIA" };
}

// Map an EngineDecision to the Solidity Decision struct tuple.
export function toSol(d: EngineDecision) {
  const phase = d.phase === "day" ? 1 : 0;
  const action = { kill: 0, save: 1, investigate: 2, vote: 3 }[d.action];
  return { phase, round: d.round, player: d.player, action, target: d.target };
}
```

- [ ] **Step 2: Write the failing test** `contracts/test/MafiaRules.test.ts`

```ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { scriptedMatch, toSol } from "./helpers/match";

describe("MafiaRules", () => {
  async function deploy() {
    const H = await ethers.getContractFactory("MafiaRulesHarness");
    return await H.deploy();
  }

  it("computes the same winner as the engine for a full scripted match", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const seed = "0x" + "11".repeat(32);
    const nonce = "rules-match-1";
    const { decisions, mafiaWins } = await scriptedMatch(seed, 5, nonce);
    const roles = engine.assignRoles(seed, 5).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));

    const [over, onchainMafiaWins] = await h.winner(roles, decisions.map(toSol));
    expect(over).to.equal(true);
    expect(onchainMafiaWins).to.equal(mafiaWins);
  });

  it("reverts on an out-of-order decision", async () => {
    const h = await deploy();
    const engine = await import("@turingpits/engine");
    const seed = "0x" + "22".repeat(32);
    const roles = engine.assignRoles(seed, 5).map((r: string) => ({ MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 }[r]));
    // A day-vote decision submitted first, while the game opens on night round 1.
    const bad = [{ phase: 1, round: 1, player: 0, action: 3, target: 1 }];
    await expect(h.winner(roles, bad)).to.be.revertedWith("out of order");
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd contracts && npx hardhat test test/MafiaRules.test.ts`
Expected: FAIL — `MafiaRulesHarness` artifact not found.

- [ ] **Step 4: Create `contracts/contracts/lib/MafiaRules.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";

/// @dev Solidity port of engine/src/moderator.ts. Mutates a memory `Game` in place.
///      Nonce/phase/round binding for cross-match replay is enforced by the caller
///      (MafiaMarket binds each decision to the signed body via the match nonce).
library MafiaRules {
    struct Game {
        Role[] roles;
        bool[] alive;
        Phase phase;
        uint32 round;
        uint8[] pendingPlayer;
        Action[] pendingAction;
        uint8[] pendingTarget;
        uint8 pendingCount;
        bool[] acted;
        bool over;
        bool mafiaWins;
    }

    function init(Role[] memory roles) internal pure returns (Game memory g) {
        uint256 n = roles.length;
        g.roles = roles;
        g.alive = new bool[](n);
        for (uint256 i = 0; i < n; i++) g.alive[i] = true;
        g.phase = Phase.Night;
        g.round = 1;
        g.pendingPlayer = new uint8[](n);
        g.pendingAction = new Action[](n);
        g.pendingTarget = new uint8[](n);
        g.acted = new bool[](n);
    }

    function applyDecision(Game memory g, Decision memory d) internal pure {
        _assertLegal(g, d);
        g.pendingPlayer[g.pendingCount] = d.player;
        g.pendingAction[g.pendingCount] = d.action;
        g.pendingTarget[g.pendingCount] = d.target;
        g.pendingCount++;
        g.acted[d.player] = true;
        if (_complete(g)) {
            if (g.phase == Phase.Night) _resolveNight(g);
            else _resolveDay(g);
        }
    }

    function _assertLegal(Game memory g, Decision memory d) private pure {
        require(!g.over, "game over");
        require(d.phase == g.phase && d.round == g.round, "out of order");
        uint256 n = g.roles.length;
        require(d.player < n, "player oob");
        require(d.target < n, "target oob");
        require(g.alive[d.player], "actor dead");
        require(g.alive[d.target], "target dead");
        if (g.phase == Phase.Day) {
            require(d.action == Action.Vote, "action not valid in day");
        } else {
            require(d.action != Action.Vote, "vote not valid in night");
            Role req = d.action == Action.Kill
                ? Role.MAFIA
                : (d.action == Action.Save ? Role.DOCTOR : Role.DETECTIVE);
            require(g.roles[d.player] == req, "role cannot act");
        }
        require(!g.acted[d.player], "already acted");
    }

    function _expectedCount(Game memory g) private pure returns (uint8 c) {
        for (uint8 i = 0; i < g.roles.length; i++) {
            if (!g.alive[i]) continue;
            if (g.phase == Phase.Day) c++;
            else if (g.roles[i] == Role.MAFIA || g.roles[i] == Role.DOCTOR || g.roles[i] == Role.DETECTIVE) c++;
        }
    }

    function _complete(Game memory g) private pure returns (bool) {
        uint8 exp = _expectedCount(g);
        return exp > 0 && g.pendingCount == exp;
    }

    function _resolveNight(Game memory g) private pure {
        (bool hasKill, uint8 killTarget) = _pluralityByAction(g, Action.Kill);
        (bool hasSave, uint8 saveTarget) = _firstByAction(g, Action.Save);
        if (hasKill && !(hasSave && saveTarget == killTarget)) {
            g.alive[killTarget] = false;
        }
        // Investigations are win-neutral; skipped on-chain.
        g.phase = Phase.Day;
        _clearPending(g);
        _computeWinner(g);
    }

    function _resolveDay(Game memory g) private pure {
        (bool hasElim, uint8 elim) = _pluralityAll(g);
        if (hasElim) g.alive[elim] = false;
        g.phase = Phase.Night;
        g.round += 1;
        _clearPending(g);
        _computeWinner(g);
    }

    function _pluralityByAction(Game memory g, Action a) private pure returns (bool, uint8) {
        uint16[] memory counts = new uint16[](g.roles.length);
        for (uint8 i = 0; i < g.pendingCount; i++) {
            if (g.pendingAction[i] == a) counts[g.pendingTarget[i]]++;
        }
        return _argmax(counts);
    }

    function _pluralityAll(Game memory g) private pure returns (bool, uint8) {
        uint16[] memory counts = new uint16[](g.roles.length);
        for (uint8 i = 0; i < g.pendingCount; i++) counts[g.pendingTarget[i]]++;
        return _argmax(counts);
    }

    /// @dev Strict plurality; ties (two targets share the max) return (false, 0). Matches
    ///      engine plurality(): order-independent winner/tie determination.
    function _argmax(uint16[] memory counts) private pure returns (bool, uint8) {
        bool found = false;
        bool tied = false;
        uint8 best = 0;
        uint16 bestC = 0;
        for (uint8 t = 0; t < counts.length; t++) {
            uint16 c = counts[t];
            if (c == 0) continue;
            if (c > bestC) { best = t; bestC = c; tied = false; found = true; }
            else if (c == bestC) { tied = true; }
        }
        if (!found || tied) return (false, 0);
        return (true, best);
    }

    function _firstByAction(Game memory g, Action a) private pure returns (bool, uint8) {
        for (uint8 i = 0; i < g.pendingCount; i++) {
            if (g.pendingAction[i] == a) return (true, g.pendingTarget[i]);
        }
        return (false, 0);
    }

    function _clearPending(Game memory g) private pure {
        g.pendingCount = 0;
        for (uint8 i = 0; i < g.acted.length; i++) g.acted[i] = false;
    }

    function _computeWinner(Game memory g) private pure {
        uint8 mafia = 0;
        uint8 town = 0;
        for (uint8 i = 0; i < g.roles.length; i++) {
            if (!g.alive[i]) continue;
            if (g.roles[i] == Role.MAFIA) mafia++;
            else town++;
        }
        if (mafia == 0) { g.over = true; g.mafiaWins = false; }
        else if (mafia >= town) { g.over = true; g.mafiaWins = true; }
    }
}
```

- [ ] **Step 5: Create `contracts/contracts/test/MafiaRulesHarness.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../MafiaTypes.sol";
import "../lib/MafiaRules.sol";

contract MafiaRulesHarness {
    function winner(Role[] calldata roles, Decision[] calldata decisions) external pure returns (bool over, bool mafiaWins) {
        MafiaRules.Game memory g = MafiaRules.init(roles);
        for (uint256 i = 0; i < decisions.length; i++) {
            MafiaRules.applyDecision(g, decisions[i]);
        }
        return (g.over, g.mafiaWins);
    }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd contracts && npx hardhat test test/MafiaRules.test.ts`
Expected: PASS (2 passing). If the scripted match fails to terminate, inspect the strategy in `match.ts` — the night kill must land (non-doctor town target) so the population strictly shrinks.

- [ ] **Step 7: Commit**

```bash
git add contracts/contracts/lib/MafiaRules.sol contracts/contracts/test/MafiaRulesHarness.sol contracts/test/MafiaRules.test.ts contracts/test/helpers/match.ts
git commit -m "Day 5: MafiaRules ports the moderator; winner matches engine on a full match"
```

---

### Task 5: MafiaMarket — escrow + settle orchestration + happy path

**Files:**
- Create: `contracts/contracts/MafiaMarket.sol`
- Create: `contracts/test/helpers/market.ts`
- Test: `contracts/test/MafiaMarket.test.ts`

**Interfaces:**
- Consumes: `MafiaTypes`, `DecisionCodec`, `TeeEnvelope`, `MafiaRules`; helpers `scriptedMatch`/`toSol` (Task 4), `buildEnvelope`/`PROVIDER_META` (Task 3).
- Produces: `MafiaMarket` with `constructor()` (host = deployer), `openMarket(bytes32 roleCommit, address teeSigner, string providerType, string providerIdentity, string tlsFingerprint, string nonce, uint8 playerCount)`, `placeBet(Side) payable`, `lockBetting()`, `settle(Move[] moves, Role[] revealedRoles, bytes32 salt)`, `claim()`; views `state()`, `winningSide()`, `yesPool()`, `noPool()`. `struct Move {Decision decision; bytes rawResponseBody; uint256 contentOffset; uint256 contentLen; string reqHashHex; bytes signature;}`. Helper `buildSettlement(seed,n,nonce,signer) → {moves, roles, salt, commit, mafiaWins}`.

- [ ] **Step 1: Create `contracts/contracts/MafiaMarket.sol`**

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MafiaTypes.sol";
import "./lib/DecisionCodec.sol";
import "./lib/TeeEnvelope.sol";
import "./lib/MafiaRules.sol";

/// @title MafiaMarket — parimutuel YES/NO faction-win market with fully on-chain,
///        TEE-verified, trustless settlement for one AI-Mafia match.
contract MafiaMarket {
    enum State { Open, Locked, Settled }

    struct Move {
        Decision decision;
        bytes rawResponseBody;
        uint256 contentOffset;
        uint256 contentLen;
        string reqHashHex;
        bytes signature;
    }

    address public host;
    State public state;

    bytes32 public roleCommit;
    address public teeSigner;
    string public providerType;
    string public providerIdentity;
    string public tlsFingerprint;
    string public nonce;
    uint8 public playerCount;

    uint256 public yesPool;
    uint256 public noPool;
    mapping(address => uint256) public yesStake;
    mapping(address => uint256) public noStake;

    Side public winningSide;
    mapping(address => bool) public claimed;

    modifier onlyHost() {
        require(msg.sender == host, "not host");
        _;
    }

    constructor() {
        host = msg.sender;
    }

    function openMarket(
        bytes32 _roleCommit,
        address _teeSigner,
        string calldata _providerType,
        string calldata _providerIdentity,
        string calldata _tlsFingerprint,
        string calldata _nonce,
        uint8 _playerCount
    ) external onlyHost {
        require(roleCommit == bytes32(0), "already opened");
        require(_playerCount >= 5 && _playerCount <= 7, "bad player count");
        roleCommit = _roleCommit;
        teeSigner = _teeSigner;
        providerType = _providerType;
        providerIdentity = _providerIdentity;
        tlsFingerprint = _tlsFingerprint;
        nonce = _nonce;
        playerCount = _playerCount;
        state = State.Open;
    }

    function placeBet(Side side) external payable {
        require(state == State.Open, "betting not open");
        require(msg.value > 0, "zero stake");
        if (side == Side.Yes) { yesPool += msg.value; yesStake[msg.sender] += msg.value; }
        else { noPool += msg.value; noStake[msg.sender] += msg.value; }
    }

    function lockBetting() external onlyHost {
        require(state == State.Open, "not open");
        state = State.Locked;
    }

    function settle(Move[] calldata moves, Role[] calldata revealedRoles, bytes32 salt) external onlyHost {
        require(state == State.Locked, "not locked");

        // 1. Commit-reveal: sha256(roleBytes ++ salt) == roleCommit (precompile 0x2).
        require(revealedRoles.length == playerCount, "roles length");
        bytes memory roleBytes = new bytes(revealedRoles.length);
        for (uint256 i = 0; i < revealedRoles.length; i++) {
            roleBytes[i] = bytes1(uint8(revealedRoles[i]));
        }
        require(sha256(bytes.concat(roleBytes, salt)) == roleCommit, "role reveal mismatch");

        // 2. Verify each move's TEE envelope + bind its decision to the signed body, then apply.
        MafiaRules.Game memory g = MafiaRules.init(revealedRoles);
        for (uint256 i = 0; i < moves.length; i++) {
            Move calldata mv = moves[i];
            address signer = TeeEnvelope.recover(
                mv.rawResponseBody, mv.reqHashHex, providerType, providerIdentity, tlsFingerprint, mv.signature
            );
            require(signer == teeSigner, "bad TEE signature");

            string memory expected = DecisionCodec.jsonEscape(DecisionCodec.encode(nonce, mv.decision));
            require(_sliceEquals(mv.rawResponseBody, mv.contentOffset, mv.contentLen, bytes(expected)), "decision not bound to body");

            MafiaRules.applyDecision(g, mv.decision); // reverts on illegal/out-of-order
        }

        // 3. The decisions must complete a game.
        require(g.over, "decisions do not complete a game");
        winningSide = g.mafiaWins ? Side.Yes : Side.No;
        state = State.Settled;
    }

    function claim() external {
        require(state == State.Settled, "not settled");
        require(!claimed[msg.sender], "already claimed");
        uint256 winnerStake = winningSide == Side.Yes ? yesStake[msg.sender] : noStake[msg.sender];
        require(winnerStake > 0, "nothing to claim");
        uint256 winningPool = winningSide == Side.Yes ? yesPool : noPool;
        uint256 payout = ((yesPool + noPool) * winnerStake) / winningPool;
        claimed[msg.sender] = true;
        (bool ok, ) = msg.sender.call{value: payout}("");
        require(ok, "transfer failed");
    }

    function _sliceEquals(bytes calldata body, uint256 offset, uint256 len, bytes memory expected) private pure returns (bool) {
        if (offset + len > body.length) return false;
        if (len != expected.length) return false;
        return keccak256(body[offset:offset + len]) == keccak256(expected);
    }
}
```

- [ ] **Step 2: Create `contracts/test/helpers/market.ts`**

```ts
import { ethers } from "hardhat";
import type { Wallet } from "ethers";
import { scriptedMatch, toSol, type EngineDecision } from "./match";
import { buildEnvelope } from "./envelope";

export interface SettlementFixture {
  moves: any[];
  roles: number[];
  salt: string;
  commit: string;
  nonce: string;
  playerCount: number;
  mafiaWins: boolean;
}

const ROLE_ENUM: Record<string, number> = { MAFIA: 0, DOCTOR: 1, DETECTIVE: 2, TOWN: 3 };

/** Build a full honest settlement: real-shaped envelopes over the scripted match. */
export async function buildSettlement(
  seed: string, n: number, nonce: string, signer: Wallet,
): Promise<SettlementFixture> {
  const engine = await import("@turingpits/engine");
  const { decisions, mafiaWins } = await scriptedMatch(seed, n, nonce);
  const roleNames = engine.assignRoles(seed, n) as string[];
  const roles = roleNames.map((r) => ROLE_ENUM[r]);
  const salt = engine.generateSalt();
  const commit = engine.commitRoles(roleNames, salt);

  const moves = [];
  for (const d of decisions as EngineDecision[]) {
    const decisionStr = engine.encodeDecision(d);
    const env = await buildEnvelope(signer, decisionStr);
    moves.push({ decision: toSol(d), ...env });
  }
  return { moves, roles, salt, commit, nonce, playerCount: n, mafiaWins };
}
```

- [ ] **Step 3: Write the failing happy-path test** `contracts/test/MafiaMarket.test.ts`

```ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { PROVIDER_META } from "./helpers/envelope";
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
```

> Note: the fixture's winning side may be YES or NO depending on the seed; the test claims with whichever side won and asserts the full 4-ETH pot, since each side has exactly one bettor here.

- [ ] **Step 4: Run to verify it fails**

Run: `cd contracts && npx hardhat test test/MafiaMarket.test.ts`
Expected: FAIL — first run before contract compiles, or assertion mismatch if logic is off.

- [ ] **Step 5: Compile and run to verify it passes**

Run: `cd contracts && npx hardhat compile && npx hardhat test test/MafiaMarket.test.ts`
Expected: PASS (1 passing). If `winningSide` mismatches, confirm `MafiaRules` and the helper use the same roles ordering and that `commitRoles`/`assignRoles` use the same seed.

- [ ] **Step 6: Commit**

```bash
git add contracts/contracts/MafiaMarket.sol contracts/test/helpers/market.ts contracts/test/MafiaMarket.test.ts
git commit -m "Day 5: MafiaMarket escrow + TEE-verified on-chain settlement; happy path green"
```

---

### Task 6: Adversarial & guard tests (the cheat path)

**Files:**
- Modify: `contracts/test/MafiaMarket.test.ts` (add a second `describe` block)

**Interfaces:**
- Consumes: everything from Task 5.

- [ ] **Step 1: Add the adversarial test block to `contracts/test/MafiaMarket.test.ts`**

```ts
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
    // Re-sign one move's envelope with a different wallet.
    const attacker = ethers.Wallet.createRandom();
    const engine = await import("@turingpits/engine");
    const { buildEnvelope } = await import("./helpers/envelope");
    const tampered = fx.moves.map((m: any) => ({ ...m }));
    // Rebuild move 0's envelope with the attacker key (same decision string).
    const decisionStr0 = engine.encodeDecision(
      // reconstruct the engine decision for move 0 from the scripted match
      (await import("./helpers/match")).toSol === undefined ? null as any : null as any,
    );
    // Simpler: just swap the signature for a valid-but-wrong-key signature over the same body.
    const env = await buildEnvelope(attacker, "ignored"); // body differs; but we only need a wrong signer
    tampered[0] = { ...tampered[0], signature: env.signature, rawResponseBody: env.rawResponseBody, contentOffset: env.contentOffset, contentLen: env.contentLen, reqHashHex: env.reqHashHex };
    await expect(market.settle(tampered, fx.roles, fx.salt)).to.be.reverted; // bad TEE signature or decision not bound
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
```

> Simplify the forged-signature test if the inline reconstruction is awkward: the goal is a move whose envelope recovers to a non-registered signer, which must make `settle` revert. Swapping in any `buildEnvelope(attackerWallet, ...)` output for move 0 achieves that (it reverts on either `bad TEE signature` or `decision not bound to body`).

- [ ] **Step 2: Clean up the forged-signature test**

Replace the awkward inline block in the forged-signature test with the minimal version:

```ts
  it("reverts a forged signature (signed by the wrong key)", async () => {
    const { market, fx } = await setup();
    await market.lockBetting();
    const attacker = ethers.Wallet.createRandom();
    const { buildEnvelope } = await import("./helpers/envelope");
    const env = await buildEnvelope(attacker, '{"nonce":"x","phase":"night","round":1,"player":0,"action":"kill","target":2}');
    const tampered = fx.moves.map((m: any) => ({ ...m }));
    tampered[0] = { decision: fx.moves[0].decision, ...env };
    await expect(market.settle(tampered, fx.roles, fx.salt)).to.be.reverted;
  });
```

- [ ] **Step 3: Run the full contracts suite**

Run: `cd contracts && npx hardhat test`
Expected: PASS — all suites green (DecisionCodec, TeeEnvelope, MafiaRules, MafiaMarket happy + cheat/guard paths).

- [ ] **Step 4: Commit**

```bash
git add contracts/test/MafiaMarket.test.ts
git commit -m "Day 5: cheat-path tests — forged sig, dropped move, bad reveal, double-claim, lock guards"
```

---

### Task 7: Deploy to 0G Galileo testnet + record address

**Files:**
- Rewrite: `contracts/scripts/deploy.ts`
- Modify: `contracts/hardhat.config.ts` (add chainId 16602)
- Modify: `STATUS.md` (record deployed address + mark Day 5 done)

**Interfaces:**
- Consumes: `MafiaMarket` (Task 5).

- [ ] **Step 1: Add chainId to `contracts/hardhat.config.ts`**

Modify the `zeroG` network block so it reads:

```ts
    zeroG: {
      url: process.env.ZEROG_RPC_URL ?? "https://evmrpc-testnet.0g.ai",
      chainId: 16602,
      accounts: (process.env.DEPLOYER_PRIVATE_KEY ?? "") ? [process.env.DEPLOYER_PRIVATE_KEY as string] : [],
    },
```

- [ ] **Step 2: Rewrite `contracts/scripts/deploy.ts`**

```ts
import { ethers } from "hardhat";

// Deploys MafiaMarket to 0G Galileo testnet. The market is opened in a later orchestration
// step (server, Day 6/7) with the real role commit + provider metadata; deploy only needs
// the contract on-chain with its address recorded.
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "0G");

  const Market = await ethers.getContractFactory("MafiaMarket");
  const market = await Market.deploy();
  await market.waitForDeployment();
  const address = await market.getAddress();
  console.log("MafiaMarket deployed to:", address);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
```

- [ ] **Step 3: Deploy to testnet**

Run: `cd contracts && node --env-file=../.env $(npm root)/.bin/hardhat run scripts/deploy.ts --network zeroG`
(If `--env-file` is awkward, ensure `DEPLOYER_PRIVATE_KEY` and `ZEROG_RPC_URL` are exported, then `npx hardhat run scripts/deploy.ts --network zeroG`.)
Expected: prints `MafiaMarket deployed to: 0x...`. Copy the address. If it fails with insufficient funds, claim from `https://faucet.0g.ai` (`myTasks.md §D`) and retry.

- [ ] **Step 4: Record the address in `STATUS.md`**

Update the "Current task" and "Done" sections: mark Day 5 complete and add the deployed `MafiaMarket` address, noting the verification mechanism is real and the test signer is a labeled local key (real TEE wiring into the live match is Day 6/7 follow-up).

- [ ] **Step 5: Commit**

```bash
git add contracts/scripts/deploy.ts contracts/hardhat.config.ts STATUS.md
git commit -m "Day 5: deploy MafiaMarket to 0G Galileo testnet; record address in STATUS"
```

---

## Self-Review

**Spec coverage:**
- §3 lifecycle (Open→Locked→Settled, parimutuel, host-only) → Task 5. ✓
- §4 commit-reveal (sha256 precompile, roleBytes++salt) → Task 5 settle step 1; cross-checked via `commitRoles` in the fixture. ✓
- §5 envelope verification (sha256 0x2 → rebuild → EIP-191 → ecrecover) → Task 3 + Task 5. ✓
- §5 offset/slice binding (jsonEscape(encodeDecision)) → Task 2 (codec) + Task 5 `_sliceEquals`. ✓
- §6 on-chain Mafia state machine → Task 4 + Task 5. ✓
- §7 tests (happy, forged sig, dropped move, bad reveal, settle-before-lock, double-claim, bet-after-lock) → Task 5 + Task 6. ✓
- §8 deploy + record address → Task 7. ✓

**Placeholder scan:** No "TBD"/"implement later"; all code is concrete. The Task 6 forged-sig test has a documented two-step (rough then cleaned) — Step 2 gives the final version. ✓

**Type consistency:** `Decision` struct field order `(phase, round, player, action, target)` is consistent across `MafiaTypes.sol`, `toSol`, and all tests. `Role` enum order matches `ROLE_ENUM`. `buildEnvelope` returns the same fields the `Move` struct consumes. `winningSide` 0/1 == `Side.No/Yes` consistent in market + tests. ✓

**Known risks flagged in-plan:** scripted-match termination (Task 4 Step 6 note); `winningSide` seed-dependence (Task 5 Step 3 note); engine must be built before tests (Global Constraints).
