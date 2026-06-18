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
