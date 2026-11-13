# Feral

[![CI](https://github.com/Marvy247/Feral_/actions/workflows/ci.yml/badge.svg)](https://github.com/Marvy247/Feral_/actions/workflows/ci.yml)

**An AI agent can ask to move money. It cannot move more than the policy allows, and the policy is enforced by a contract the agent cannot rewrite.**

Feral is policy-enforced custody for autonomous agents on NEAR. The agent holds a function-call key that can only call `spend()`. The contract holding the funds recomputes every limit, reputation score and anomaly signal from its own storage before a single unit moves. The model can be fooled, compromised or replaced: the policy is data, and the enforcement runs outside the model entirely.

> **Open the product without installing anything:** [`docs/demo/index.html`](docs/demo/index.html) - the shipping engine compiled to one static page (52 escape attempts, every check, a live console). Also published at
> `https://raw.githack.com/Marvy247/Feral_/main/docs/demo/index.html`.

**Live testnet vault:** `aa0cfa9951c95da04c563952ca56c79d078e10fb73c8987e66bed2d4202d38fb`
([account](https://testnet.nearblocks.io/account/aa0cfa9951c95da04c563952ca56c79d078e10fb73c8987e66bed2d4202d38fb) · [redeploy tx](https://testnet.nearblocks.io/txns/yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43W) · [denied spend tx](https://testnet.nearblocks.io/txns/B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU))

---

```
agent ──► intent ──► [ Feral on-chain engine ] ──► allow ──► funds move
                            │  deny ───────────► nothing moves, reason + reputation update
                            └─ require_approval ─► human co-signs, re-checked at execution
```

---

## 1. The problem

An agent with a wallet is an account with initiative and no judgment. Both standard answers are wrong:

- **Give the agent the key.** One prompt injection, one leaked `.env`, one bad tool call, and the balance is gone. Nothing bounds the damage.
- **Put a human in front of every action.** Then it is not an agent, it is a form.

Feral is the third option: the money lives in a contract, the agent's key can only ask that contract to `spend()`, and the contract recomputes the limits from its own storage on every call. A refusal reverts the transaction **and** emits a NEP-297 `deny` event carrying the reason code, so the agent can read why it was stopped.

## 2. Try it: do X, see Y

Nothing below needs a wallet, a key or funds. Steps 0-9 run offline; step 10 is the optional live testnet check. Node.js >= 22.6 runs the TypeScript directly; there is no build step.

| # | Do this | See that |
|---|---|---|
| 0 | Open [`docs/demo/index.html`](docs/demo/index.html) | The real engine in your browser: 52 escape attempts, every check, a live console you can push actions through |
| 1 | `npm run test:all` | The whole suite green, offline: engine, policy, guard, governance, reputation, anomaly, breakers, chain signatures, the adversarial catalogue and the browser-bundle equivalence test |
| 2 | `npm run attack` | A 52-row table of escape attempts, each naming the wall it hit: `52 attempts: 44 denied, 1 to a human, 4 allowed` |
| 3 | `npm run verify` | 1000 random actions with 7 invariants checked after each: `ALL PASS` |
| 4 | `npm run agent:attack` | A prompt-injected agent tries three escapes (full amount, split retry, policy rewrite). All three denied, reputation drops 100 → 70, the audit chain verifies |
| 5 | `npm run demo:judge` | 25 decisions across 3 agents and 1 vault, with approvals, reputation penalties and the audit chain: `FERAL DEMO COMPLETE  25 decisions, 0 failures` |
| 6 | `npm run serve` | The same guard as an HTTP API plus a dashboard on `http://127.0.0.1:8787` |
| 7 | `npm run verify:claims` | Every claim in this README, re-measured right now, with the command that proves it |
| 8 | `npm run preflight` | The repository checked against itself: policy compiles, wasm matches, links resolve, every command above exits 0 |
| 9 | `cd contract && cargo test` | The Rust vault's own unit tests on a NEAR VM |
| 10 | `npm run chain:conformance` | 37 checks against the deployed contract on testnet, with each refusal's reason code read back from the on-chain event |

## 3. The proof, and how to check it

Every number below is re-measured by `npm run verify:claims`, which runs the command and compares the output. A claim that stops being true fails the command, and the README's counts are asserted by the test suite.

| Claim | Command | What it prints |
|---|---|---|
| The suite passes offline | `npm run test:all` | `pass 186`, `fail 0` |
| Every escape attempt is caught | `npm run attack` | `52 attempts: 44 denied, 1 to a human, 4 allowed` |
| The invariants hold under randomness | `npm run verify` | `1000 actions, 3 agents` · `7 invariants verified` · `ALL PASS` |
| A prompt injection cannot move money | `npm run agent:attack` | `the model was fooled; the vault was not` |
| The vault has its own tests | `cd contract && cargo test` | `test result: ok` |
| The deployed vault agrees with the mirror | `npm run chain:conformance` | `37/37` checks |
| The browser demo is the real engine | `npm run demo:check` | `demo bundle is current` |
| The manifest matches the code | `npm run caps:check` | `capability manifest is current` |

The catalogue behind those numbers is 52 adversarial scenarios, each with an expected verdict that the test suite, the `feral attack` command and the browser demo all assert independently.

## 4. What runs where

The engine runs twice. The Rust vault recomputes the fund-moving checks from its own storage on every call, so a compromised off-chain process cannot widen the limits. The TypeScript mirror runs the same checks plus the quote-level ones the contract cannot see (a quote's venue, expiry and output address), before submission, so refusals come with an explanation instead of a revert.

<!-- CHECKS:BEGIN -->

| # | Check | Reason code | Enforced by | Vault section | Demonstrated by scenario |
|---|---|---|---|---|---|
| 1 | `daily-budget` | `DAILY_LIMIT` | **on-chain** | 9. Rolling daily limit | 2, 35, 48 |
| 2 | `monthly-budget` | `MONTHLY_LIMIT` | **on-chain** | 10. Rolling monthly limit | 2, 35 |
| 3 | `structure` | `INVALID_ACTION` | off-chain | - | 9, 10 |
| 4 | `asset-registry` | `UNKNOWN_ASSET` | off-chain | - | 11 |
| 5 | `amount-parses` | `INVALID_AMOUNT` | off-chain | - | 3, 4, 6 |
| 6 | `amount-positive` | `NON_POSITIVE_AMOUNT` | **on-chain** | 6. Amount is positive | 5 |
| 7 | `actor` | `ACTOR_NOT_AGENT` | off-chain | - | 15 |
| 8 | `replay` | `REPLAY` | off-chain | - | 47 |
| 9 | `paused` | `POLICY_PAUSED` | off-chain | - | 28 |
| 10 | `expiry` | `POLICY_EXPIRED` | off-chain | - | 29 |
| 11 | `vault-freeze` | `EMERGENCY_FREEZE` | **on-chain** | 1. Vault-level circuit breaker | 38 |
| 12 | `vault-paused` | `VAULT_PAUSED` | **on-chain** | 1. Vault-level circuit breaker | - |
| 13 | `agent-paused` | `AGENT_PAUSED` | **on-chain** | 2. Agent-level circuit breaker | - |
| 14 | `agent-breaker` | `AGENT_PAUSED` | **on-chain** | 2. Agent-level circuit breaker | - |
| 15 | `attestation` | `ATTESTATION_REQUIRED`, `ATTESTATION_MISMATCH` | **on-chain** | 4. TEE attestation | 39, 40 |
| 16 | `reputation-floor` | `REPUTATION_FROZEN` | **on-chain** | 5. Reputation floor | 35 |
| 17 | `action-kind` | `ACTION_NOT_ALLOWED` | **on-chain** | 7. Action kind allow / deny | 10, 16, 17, 18 |
| 18 | `anomaly-burst` | `ANOMALY_BURST` | **on-chain** | 7b. Velocity: burst window | 32 |
| 19 | `per-tx` | `PER_TX_LIMIT`, `UNPRICED_ASSET`, `NO_LIMIT_FOR_ASSET` | **on-chain** | 8. Per-tx limit (reputation and breaker adjusted) | 1, 2, 35, 36, 37 |
| 20 | `aggregate-daily` | `AGGREGATE_DAILY_LIMIT` | **on-chain** | 11. Aggregate vault limits | 2, 30 |
| 21 | `aggregate-monthly` | `AGGREGATE_MONTHLY_LIMIT` | **on-chain** | 11. Aggregate vault limits | 2 |
| 22 | `usd-price` | `UNPRICED_ASSET` | off-chain | - | - |
| 23 | `approval-threshold` | `APPROVAL_REQUIRED` | **on-chain** | 18. Approval threshold | 1, 2, 25, 30, 36, 48 |
| 24 | `recipient-format` | `INVALID_RECIPIENT` | off-chain | - | 7, 8, 14 |
| 25 | `recipient-deny` | `RECIPIENT_DENIED` | **on-chain** | 12. Counterparty controls | 13 |
| 26 | `recipient-allow` | `RECIPIENT_NOT_ALLOWED` | **on-chain** | 12. Counterparty controls | 12, 13, 31 |
| 27 | `new-recipient` | `APPROVAL_REQUIRED` | **on-chain** | 18. Approval threshold | 12, 13, 31 |
| 28 | `velocity-hourly` | `RATE_LIMIT_HOURLY` | off-chain | - | - |
| 29 | `velocity-interval` | `RATE_LIMIT_INTERVAL` | **on-chain** | 13. Velocity: minimum interval | 32, 33, 34, 47 |
| 30 | `quote-present` | `MISSING_QUOTE` | off-chain | - | 19 |
| 31 | `venue` | `VENUE_NOT_ALLOWED` | off-chain | - | 22 |
| 32 | `slippage` | `SLIPPAGE_TOO_HIGH` | off-chain | - | 20 |
| 33 | `quote-expiry` | `QUOTE_EXPIRED` | off-chain | - | 23 |
| 34 | `origin-asset` | `ORIGIN_ASSET_MISMATCH` | off-chain | - | 24 |
| 35 | `destination` | `DESTINATION_NOT_ALLOWED` | **on-chain** | 15. Intent checks | 19, 21 |
| 36 | `anomaly-drainage` | `ANOMALY_DRAINAGE` | **on-chain** | 16. Anomaly: drainage concentration | 32, 33 |
| 37 | `anomaly-deviation` | `ANOMALY_DEVIATION` | **on-chain** | 17. Anomaly: deviation from baseline | 34 |
| 38 | `risk-escalation` | `RISK_BUDGET_SHARE` | off-chain | - | - |
| 39 | `risk-new-counterparty` | `RISK_NEW_COUNTERPARTY` | off-chain | - | - |

**22 checks enforced on-chain**, 17 more in the off-chain mirror, 25 reason codes in the Rust vault, 42 in the engine.

<!-- CHECKS:END -->

The machine-readable version of this table is [`docs/CAPABILITIES.json`](docs/CAPABILITIES.json): every check with its id, title, reason code, the contract section that enforces it, and the scenario numbers that demonstrate it. It is generated from the code by `npm run caps:gen` and the test suite fails if it drifts.

## 5. What is different from another spending cap

Most agent wallets in this space are a policy check inside the agent's process, right before it signs. That has one failure mode worth naming: if the process is compromised, the check goes with it. Feral moves six things out of the agent's process and into the contract or the policy:

| | a check before signing | Feral |
|---|---|---|
| Where the money is | the agent's wallet | a contract; the agent holds a `spend`-only function-call key |
| Where the limits are recomputed | the agent's process | the contract's own storage, on every call |
| What a refusal produces | an exception the agent may swallow | a reverted transaction **and** a NEP-297 `deny` event carrying the reason code |
| How approval works | a flag in memory | a queued request that re-runs the policy at execution time, so a stale approval cannot be spent |
| Where the audit lives | a local log file | a hash chain whose head is anchored on-chain, so an edited record is detectable later |
| What a mistake costs | nothing | reputation, then a lower limit, then a breaker, then a freeze |

### Adaptive reputation

Reputation is not a score on a leaderboard: it scales every limit. `reputation = 100` is the full cap; a denial costs 10, an anomaly costs 15, a clean spend earns 1 back, and an agent that has been clean for 30 days recovers 20. At `reputation = 0` the agent is frozen and cannot spend at all. The arithmetic is in [`src/core/reputation.ts`](src/core/reputation.ts) and it is the same arithmetic in the Rust vault.

### On-chain anomaly detection

Three detectors, all running inside the vault: a **burst** (more than 5 spends in 60 seconds), **drainage** (a single transfer above half the daily budget) and **deviation** (a transfer that is 5 standard deviations from the agent's own baseline). A hit raises the anomaly score, cuts the limits and pushes the agent toward a human.

### Four-level circuit breakers

Level 1 cuts every limit by 90% for an hour. Level 2 pauses the agent and needs the owner. Level 3 pauses the vault and needs a quorum. Level 4 is an emergency freeze that only the owner can lift, with the reason recorded on-chain.

### Multi-agent coordination security

One vault, three agents, and vault-wide aggregate caps that no combination of agents can cross. Two agents that each stay under their own per-tx limit still hit the vault's daily cap if they spend together - the coordination attack is refused.

### Governance

Policy changes are timelocked. A proposed change cannot execute until the delay elapses, watchers can cancel it, and the owner can freeze the vault without waiting. Every administrative action is a timelock record with an actor, not a function call.

### Attestation

An agent can be required to present a TEE attestation proof. The vault hashes the proof with SHA-256 and compares it to the hash committed for that agent; a missing proof is `ATTESTATION_REQUIRED`, a wrong one is `ATTESTATION_MISMATCH`. Both are enforced on-chain.

### A shared counterparty registry

Before an agent submits a spend, Feral queries a cross-vault counterparty registry. Any vault can report a bad address with evidence; every other vault benefits immediately, including vaults that have never seen that address before. One independent reporter means *warn* (escalate to a human); two independent reporters mean *block* (refuse before the guard is called, so the agent's key never signs). `npm run blocklist:attack` runs the attack end to end.

### A live signing path, verified

`npm run chain:mpc` builds an EIP-1559 transfer, requests a chain signature from `v1.signer-prod.testnet`, and accepts it only if the recovered public key matches the MPC-derived key. On 2026-11-11 the signature recovered to `0x8251684b91a8cc4c95526ea171dc2b07580abdd9`, and the signed 1-wei transfer was included on Sepolia in block `12111331` (tx `0x57198e54...`), status 1. The Rust vault still does not call the signer itself - that is stated plainly here rather than implied.

## 6. The policy a human writes

`examples/policy.yaml` is the whole policy, short enough to read in a minute: per-tx, daily and monthly limits per asset per agent, vault-wide aggregate caps, strict counterparty mode, an approval threshold with a quorum, velocity windows, an action-kind allow list, swap venue and slippage ceilings, a pinned output address, reputation and anomaly configuration, breaker durations and the timelock delay. The policy is pinned by hash; the hash goes on-chain and into every audit record, so a changed rule is visible after the fact.

## 7. Live deployment

| Step | Transaction |
|---|---|
| deploy contract | [`BdH6yyLJJP6S7e5kN6miCZfbTDSikcDvYaiag9L2rZ8U`](https://testnet.nearblocks.io/txns/BdH6yyLJJP6S7e5kN6miCZfbTDSikcDvYaiag9L2rZ8U) |
| initialise vault | [`VfXq2aTha93uqX1Mw6FyPDVbr1cKxg5Hp6x94DmVRbK`](https://testnet.nearblocks.io/txns/VfXq2aTha93uqX1Mw6FyPDVbr1cKxg5Hp6x94DmVRbK) |
| agent adds a `spend`-only key | [`QErm94LZNULkrZKMcR3ZPSeTAHdTrPx9PgBpu3rh5N6`](https://testnet.nearblocks.io/txns/QErm94LZNULkrZKMcR3ZPSeTAHdTrPx9PgBpu3rh5N6) |
| agent deletes its full-access key | [`HcduMfcK32DvHFCeSW9YVqy5Pfkskmg59pnmh1gyevPB`](https://testnet.nearblocks.io/txns/HcduMfcK32DvHFCeSW9YVqy5Pfkskmg59pnmh1gyevPB) |
| owner installs the policy | [`FLkbBdSvPZPXpSxhtVKMnHH7a6gs7Xzm5NrrF8GGaXno`](https://testnet.nearblocks.io/txns/FLkbBdSvPZPXpSxhtVKMnHH7a6gs7Xzm5NrrF8GGaXno) |
| allowed spend (0.25 NEAR) | [`3iHNfcpBwRJxWhTCSUD5Ba8d3AHH4dfTGpKA4yDc7F56`](https://testnet.nearblocks.io/txns/3iHNfcpBwRJxWhTCSUD5Ba8d3AHH4dfTGpKA4yDc7F56) |
| redeploy the fixed vault | [`yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43W`](https://testnet.nearblocks.io/txns/yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43W) |
| denied spend (1.5 NEAR) | [`B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU`](https://testnet.nearblocks.io/txns/B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU) |
| prompt-injection denial (25 USDC intent) | [`HGhtZPxANEpus1wiDV9XmxtBHvDtQfoVqxR1PS4CC419`](https://testnet.nearblocks.io/txns/HGhtZPxANEpus1wiDV9XmxtBHvDtQfoVqxR1PS4CC419) |

The full transcript, the `deny` event payloads and the state read back from the contract: [`docs/TESTNET.md`](docs/TESTNET.md).

## 8. Repository layout

```
contract/src/lib.rs      the Rust vault: policy, reputation, anomaly, breakers, timelocks, approvals
contract/res/            the built wasm, and the hash the preflight checks
src/core/engine.ts       evaluate(policy, action, ledgerView, ctx) -> Decision - pure, no I/O, no clock
src/core/service.ts      FeralGuard: submissions, reservations, approvals, governance, simulation
src/core/policy.ts       v2 policy schema, strict validation, compilation, hash pinning
src/core/reputation.ts   reputation arithmetic and effective limits
src/core/anomaly.ts      burst, drainage and deviation detection
src/core/circuit.ts      the four-level breaker state machine
src/core/blocklist.ts    the shared cross-vault counterparty registry
src/core/money.ts        exact bigint money; parseAmount refuses silent rounding
src/demo/scenarios.ts    the scenario catalogue: one source of truth for tests, CLI, demo page
src/browser/             the browser build: shims, the demo entry, the page template
scripts/build-demo.ts    compiles the engine into docs/demo/index.html (no dependencies)
scripts/gen-capabilities.ts  generates docs/CAPABILITIES.json from the code
scripts/verify-claims.ts re-measures every claim in this README
src/app/                 the dependency-free HTTP guard and its console
dashboard/               the Next.js product dashboard; holds no policy logic
test/unit/               the test suite
docs/demo/               the built browser demo
```

## 9. How this repository verifies itself

| Command | What it proves |
|---|---|
| `npm run preflight` | The repository is shippable: policy compiles, the wasm matches the quoted hash, links resolve, every documented command exits 0 |
| `npm run verify:claims` | Every claim in section 3 is re-measured, with the measured output printed |
| `npm run caps:check` | The capability manifest still matches the engine, the vault and the catalogue |
| `npm run demo:check` | The committed browser demo is exactly what the current sources build, and it reproduces all 52 verdicts |
| `npm run audit:docs` | Every command and path mentioned in the documentation exists |
| `npm run test:all` | The suite, offline |

## 10. Submission

The submission checklist, the payload validator and the exact fields the form needs are in [`docs/SUBMISSION.md`](docs/SUBMISSION.md) and [`scripts/submit.mjs`](scripts/submit.mjs). Nothing is ever sent without an explicit confirmation.

## 11. Licence

MIT. Built for the **NEAR HACKATHON - AI Security & Defense** track, November 2026.
