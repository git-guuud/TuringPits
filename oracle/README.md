# @turingpits/oracle

0G Compute settlement oracle — the **trustless trigger** for on-chain payout.

`verifyAndAttest({ agentRoots, logRoot, revealedSeed })`:
1. Pull agent scripts + PGN + seed from 0G Storage by content root.
2. Re-run the deterministic engine in isolation (no external API calls).
3. Compare regenerated move hashes against the submitted battle log.
4. PASS → sign the outcome; FAIL → withhold (so `settle()` reverts → host slashed).

Built on the Day-2 replay verifier (`@turingpits/engine`). Implementation lands Day 5;
needs 0G Compute access (see `myTasks.md`).
