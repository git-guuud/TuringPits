# Turing Pits: Gamified AI vs. AI Prediction Market

## Overview

Turing Pits is a decentralized, highly visual prediction market where users place live bets on the outcomes of autonomous AI agents battling in 100% deterministic environments. Instead of betting on dry real-world events, the platform provides a gamified, live-streaming spectacle driven by a "Bring Your Own Agent" (BYOA) model. The protocol operates as an "Optimistic Game Engine," combining the buttery-smooth user experience of a centralized Web2 live stream with the trustless, verifiable cryptographic security of the 0G network.

## Strategic Alignment: The Zero Cup Meta

This project is engineered specifically to win the 0G Zero Cup by targeting both phases of the tournament:

* 
**The Judge Phase (Early Rounds):** Evaluators look for complex, native integration of decentralized infrastructure. This architecture uses massive verifiable computation to prove 0G is doing real work, preventing the app from being disqualified as a centralized "bolt-on".


* 
**The Community Phase (Late Rounds):** From the Quarter-Finals onward, outcomes are decided entirely by public voting. By wrapping the heavy decentralized compute in a fast-paced, gamified visual spectacle, the protocol ships something the public actually wants to watch and vote for.



---

## Core System Architecture

### 1. The Live Arena (Off-Chain Execution & UI)

* The platform utilizes a traditional Web2 server functioning as the Sequencer to run the deterministic game logic locally.


* The Sequencer pulls the two competing, public AI agent scripts and the mathematically locked game seed to simulate the match.


* To create a suspenseful viewing experience, the server uses WebSockets to stream the calculated moves directly to the frontend UI at a locked pace of 1 move per second.



### 2. The Market Ledger (0G Chain)

* An Automated Market Maker (AMM) is deployed on 0G Chain to serve as the decentralized ledger.


* Bettors can buy and sell YES/NO prediction shares continuously while the live match is streaming.


* A Slashing Contract holds a locked crypto bond provided by the tournament host to secure the integrity of the off-chain execution.



### 3. The Evidence Layer (0G Storage)

* Before any match begins, the Python or JavaScript code for the competing AI agents is uploaded and locked immutably on 0G Storage.


* Because the agents are locked before betting opens, no secret malicious logic can be injected mid-game.


* Immediately after the live stream ends, the server commits the final, complete text-based battle log (e.g., a PGN file for chess) to 0G Storage.



### 4. The Settlement Oracle (0G Compute)

* 0G Compute acts as the automated oracle to cryptographically verify the off-chain game's outcome.


* It pulls the static PGN log file, the Agent Scripts, and the Revealed Seed directly from 0G Storage.


* The compute node spins up a pure-logic, 100% deterministic script to re-run the match in an isolated environment without any external API calls.


* If the independently generated move hashes perfectly match the submitted battle log hashes, 0G Compute generates a valid cryptographic signature.


* This signature is pushed to 0G Chain, proving the off-chain stream was honest and unlocking the smart contract escrow to pay the winning bettors.



---

## Security & Anti-Manipulation Mechanics

### The Seed Fix: Commit-Reveal Scheme

If players know the outcome of a deterministic game beforehand, the betting market breaks.

* 
**The Commit:** The server generates a true random Secret Seed, hashes it cryptographically, and submits only the hash to the 0G Chain smart contract before betting opens.


* 
**The Bets:** The community places bets while it remains mathematically impossible to reverse-engineer the seed from the hash.


* 
**The Reveal:** Once betting locks, the server reveals the actual Secret Seed to the contract for verification.


* 
**The Lock:** This verified seed is locked in as the official variable to generate the game arena.



### The Failsafe: Slippage Subsidization & Slashing

If the Web2 Sequencer attempts to rig the live stream (e.g., forcing an agent to make a bad move), the submitted battle log will diverge from the deterministic output of the agents' code.

* 0G Compute will detect the divergence, fail the cryptographic proof, and refuse to sign the transaction.


* The escrow remains locked and the rigged bets are canceled.


* The smart contract automatically confiscates the malicious host's locked crypto bond.


* The smart contract unlocks the escrow to refund the base collateral to the current token holders.


* The confiscated host bond is automatically distributed to token holders to subsidize any secondary market slippage, forcing the cheating host to pay for the market disruption.



---

## Development Roadmap

### June 23 Milestone: "Proof of Battle" MVP

The first code lock snapshot requires a working baseline to avoid disqualification.

* 
**Game Format:** A 100% deterministic script that 0G Compute can run instantly to declare a winner.


* 
**Escrow:** Deploy the basic betting smart contract on 0G Chain.


* 
**Evidence:** Host the competing Python/JS AI scripts and the battle log immutably on 0G Storage.


* 
**Demo:** Provide a clean frontend where judges can watch a basic simulation run and see the smart contract pay out the winner.