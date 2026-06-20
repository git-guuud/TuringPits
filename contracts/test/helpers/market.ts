import { ethers } from "hardhat";
import type { Wallet } from "ethers";
import { scriptedMatch, toSol, type EngineDecision } from "./match";
import { buildEnvelope, PROVIDER_META } from "./envelope";

export interface SettlementFixture {
  moves: any[];
  roles: number[];
  salt: string;
  commit: string;
  nonce: string;
  playerCount: number;
  mafiaWins: boolean;
  teeSigner: Wallet;
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
  return { moves, roles, salt, commit, nonce, playerCount: n, mafiaWins, teeSigner: signer };
}

/** Valid block schedule relative to the current chain head. */
export async function defaultSchedule(
  provider: { getBlockNumber(): Promise<number> },
  overrides: Partial<Record<"bettingOpenBlock" | "bettingCloseBlock" | "matchStartBlock" | "settlementDeadlineBlock", number>> = {},
) {
  const now = await provider.getBlockNumber();
  // Generous open margin: setup/validation tests fire several txs before betting; keep the
  // open block comfortably ahead of the head so "open in past" never masks other reverts.
  const bettingOpenBlock = now + 50;
  const bettingCloseBlock = bettingOpenBlock + 101; // > MIN_BETTING_WINDOW (100)
  const matchStartBlock = bettingCloseBlock + 5;    // >= LOCK_BUFFER
  const settlementDeadlineBlock = matchStartBlock + 26; // > MIN_MATCH_DURATION (25)
  return { bettingOpenBlock, bettingCloseBlock, matchStartBlock, settlementDeadlineBlock, ...overrides };
}

/** Assemble a CreateMatchParams object for ethers v6 (named struct fields). */
export function createParams(opts: {
  roleCommit: string;
  teeSigner: string;
  nonce: string;
  playerCount: number;
  schedule: { bettingOpenBlock: number; bettingCloseBlock: number; matchStartBlock: number; settlementDeadlineBlock: number };
  feeBps?: number;
  feeBpsDraw?: number;
  personaPoolRoot?: string;
}) {
  return {
    roleCommit: opts.roleCommit,
    personaPoolRoot: opts.personaPoolRoot ?? ethers.ZeroHash,
    teeSigner: opts.teeSigner,
    providerType: PROVIDER_META.providerType,
    providerIdentity: PROVIDER_META.providerIdentity,
    tlsFingerprint: PROVIDER_META.tlsFingerprint,
    nonce: opts.nonce,
    playerCount: opts.playerCount,
    bettingOpenBlock: opts.schedule.bettingOpenBlock,
    bettingCloseBlock: opts.schedule.bettingCloseBlock,
    matchStartBlock: opts.schedule.matchStartBlock,
    settlementDeadlineBlock: opts.schedule.settlementDeadlineBlock,
    feeBps: opts.feeBps ?? 200,
    feeBpsDraw: opts.feeBpsDraw ?? 50,
  };
}
