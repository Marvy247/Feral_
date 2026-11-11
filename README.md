# Feral

[![CI](https://github.com/Marvy247/Feral_/actions/workflows/ci.yml/badge.svg)](https://github.com/Marvy247/Feral_/actions/workflows/ci.yml)

**A prompt-injected AI agent can ask to move money. It cannot.**

Feral is policy-enforced custody for autonomous agents on NEAR. The agent holds a key that can only call `spend()`. The contract holding the funds recomputes every limit, reputation score, and anomaly state from its own storage before a single unit moves. The model can be fooled, compromised, or replaced — the policy is data, and the enforcement runs outside the model entirely.

> **[Watch the 2:42 narrated walkthrough](docs/feral-demo.mp4)** — live testnet denial, reputation penalty, dashboard, governance, and audit chain.

**Live testnet vault:** `aa0cfa9951c95da04c563952ca56c79d078e10fb73c8987e66bed2d4202d38fb`
([account](https://testnet.nearblocks.io/account/aa0cfa9951c95da04c563952ca56c79d078e10fb73c8987e66bed2d4202d38fb) · [redeploy tx](https://testnet.nearblocks.io/txns/yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43V) · [denied spend tx](https://testnet.nearblocks.io/txns/B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU))

---

```
agent ──► intent ──► [ Feral on-chain engine ] ──► allow ──► funds move
                            │  deny ───────────► nothing moves, reason + reputation update
                            └─ require_approval ─► human co-signs, re-checked at execution
```

---

## Five proof points

**The AI is visible, and it loses.**
`npm run agent:attack` feeds an agent a vendor page containing a hidden payment instruction. The planner prints its goal, the injection signals it found, a rationale, and JSON tool calls — the same shape a tool-calling model emits. It is a deterministic stand-in, not a hidden API call, so the denial is reproducible offline. It follows the injection, retries with a smaller split after the first refusal, then attempts to rewrite its own policy. All three attempts are denied, no payment handler runs, reputation drops from 100 to 70, and the audit chain verifies every step.

**17 checks enforced on-chain.**
Per-transaction, daily, monthly, and cross-agent limits, allow/deny lists, destination pinning, velocity controls, reputation scoring, anomaly detection, and circuit breakers all run inside the Rust vault. The off-chain engine mirrors 20 checks for previews and testing — it cannot move funds.

**A refusal is not free.**
A denied `spend()` returns `allowed: false`, emits a NEP-297 `deny` event with a reason code, moves nothing, and immediately applies a reputation and anomaly penalty. On testnet, a 1.5 NEAR attempt against a 1 NEAR cap dropped reputation from 100 to 90 in one call.

**A live signing path, verified.**
`npm run chain:mpc` builds an EIP-1559 transfer, requests a chain signature from `v1.signer-prod.testnet`, and accepts it only if the recovered public key matches the MPC-derived key. On 2026-11-11 the signature recovered to `0x8251684b91a8cc4c95526ea171dc2b07580abdd9`, and the signed 1-wei transfer was included on Sepolia in block `12111331` (tx `0x57198e54...`), status 1. The Rust vault still does not call the signer itself.

**Auditable end to end.**
159 JavaScript tests (all passing, no network), 60 Rust tests, 52 adversarial scenarios, 37/37 conformance checks against the live contract, and a hash-chained decision log. Everything verifiable offline with one command.

```bash
npm run agent:attack   # 15s: injection -> refuse -> split retry -> refuse -> policy rewrite -> refuse
npm run demo:judge     # 60s: the full allow / deny / approval / audit story
```

---

## Try it in 60 seconds — no wallet needed

Requirements: **Node.js >= 22.6**. Native TypeScript execution, no build step, zero dependencies for the default path.

```bash
npm run agent:attack   # 15s: prompt-injection demo, no wallet
npm run demo:judge     # 60s: 10 scenes, 3 agents, no wallet
npm run test:all       # 159 tests, 0 failures, no network
npm run attack         # 52 adversarial scenarios, every verdict asserted
npm run verify         # 1000 random actions, all invariants asserted
npm run serve          # dependency-free guard + dashboard on http://127.0.0.1:8787
```

![npm run demo:judge terminal output](docs/images/terminal.png)

The policy that governs the demo agents is a human-readable YAML file — [`examples/policy.yaml`](examples/policy.yaml). It declares three agents, per-asset limits, aggregate vault caps, a counterparty allowlist, velocity controls, reputation parameters, anomaly thresholds, circuit breaker config, M-of-N multisig, and timelocked governance in one file. The contract enforces it on-chain; the hash is pinned so a changed rule is visible in the audit trail.

---

## The product

![Feral landing page](docs/images/landing.png)

![Feral live dashboard reading the guard API](docs/images/dashboard.png)

The dashboard is a live client of the guard. Agent reputation, effective limits, the decision feed, anomaly flags, and the approval queue all come from `/api/summary`. Approving or rejecting a spend calls the same `FeralGuard` methods as the CLI — there is no separate approval path.

### Dashboard

The Next.js app in `dashboard/` proxies `/api/*` to the guard. Run both together:

```bash
npm run serve          # guard + JSON API on :8787
npm run dashboard      # Next dev server on :3000
```

Production build:

```bash
npm run dashboard:build && npm run dashboard:start
```

Set `FERAL_API_URL` if the guard runs somewhere other than `http://127.0.0.1:8787`. The frontend holds no policy logic — it renders guard state and posts approve/reject calls.

---

## What makes Feral different

Most agent-security products defend the prompt. Feral assumes the prompt has already been compromised, limits how much that compromise can cost, and puts the proof on chain.

| Threat | Prompt filter / LLM judge | Off-chain spend policy | Static on-chain cap | Feral |
|---|---|---|---|---|
| Injection changes the agent's goal | Re-scan or re-prompt; a paraphrase can pass | Policy sees the payment, not the reason | Not relevant | **The agent may be fully compromised. Its instruction is never authority.** |
| The checking process is compromised | Guardrail is bypassed with the process | Attacker can submit the payment | Cap still holds | **The vault recomputes limits, counterparties, reputation, and anomaly state from its own storage.** |
| The agent holds a valid key | Key can do whatever the prompt asks | Key can reach the policy service | Key can spend up to the cap | **Key can only call `spend()`; the contract decides whether that call moves funds.** |
| The agent retries with a smaller amount | May block the exact string | Depends on implementation | Each payment under the cap passes | **Denials cost reputation and tighten effective limits; the split retry is denied again.** |
| Several agents coordinate | No shared view | Shared service, not shared enforcement | Per-agent caps only | **Aggregate vault limits bind every agent together.** |
| Someone edits the audit log | Text logs, editable | Editable service log | On-chain events only for spends | **Hash-chained decisions plus on-chain events; the demo detects a hand-edited record.** |
| Recovery from a bad state | Disable the model | Operator restarts the service | Owner sweeps the funds | **Timelocks, watcher cancellation, multisig, and four circuit-breaker levels.** |

**What Feral is not:**

- Not a prompt filter or LLM judge. The model is outside the trust path by design; a better model does not make the vault safer, and a compromised one does not make it weaker.
- Not a hosted wallet. Keys stay with the operator, the agent key is scoped to `spend()`, and the owner can withdraw only through a timelock.

---

## The 20 checks

Every `spend()` call runs these in order. The contract enforces the fund-moving ones; the quote-level checks run in the pure off-chain engine before submission, because the contract only sees the final transfer.

| # | Check | Where |
|---|---|---|
| 1 | Vault emergency freeze | On-chain |
| 2 | Vault circuit breaker (level 3) | On-chain |
| 3 | Agent circuit breaker (level 2) | On-chain |
| 4 | Agent paused | On-chain |
| 5 | Attestation-proof verification (hash commitment) | On-chain |
| 6 | Amount positive and valid | On-chain |
| 7 | Action kind allow/deny list | On-chain |
| 8 | Per-tx limit (reputation-adjusted) | On-chain |
| 9 | Rolling daily limit (reputation-adjusted) | On-chain |
| 10 | Rolling monthly limit (reputation-adjusted) | On-chain |
| 11 | Aggregate vault limit (across all agents) | On-chain |
| 12 | Counterparty deny list | On-chain |
| 13 | Counterparty allow list (strict mode) | On-chain |
| 14 | Velocity: burst window (5 tx / 60s) | On-chain |
| 15 | Velocity: minimum interval between transactions | On-chain |
| 16 | Intent venue allowlist | On-chain |
| 17 | Slippage ceiling | Off-chain |
| 18 | Quote expiry | Off-chain |
| 19 | Destination address pinning (cross-chain) | Off-chain |
| 20 | Reputation floor (reputation > 0) | On-chain |

The off-chain engine mirrors all 20 checks before submission. The contract independently recomputes checks 1–16 from its own storage, with no trust in the caller.

---

## Adaptive reputation

Every agent starts at reputation 100. The contract updates it on every call:

| Event | Change |
|---|---|
| Clean spend within policy | +1 (capped at 100) |
| Denial | -10 (floored at 0) |
| Approval completed | +2 |
| Anomaly flag | -15 |

**Effective limit = `base_limit × (reputation / 100)`.**
An agent at reputation 40 operates at 40% of its daily cap. At reputation 0, the agent is frozen entirely. Reputation recovers: a 30-day clean window restores 20 points.

---

## On-chain anomaly detection

- **Burst detection** — more than 5 transactions in 60 seconds triggers circuit breaker level 1 (limits reduced to 10% for 1 hour)
- **Drainage detection** — more than 50% of the daily limit sent to one address triggers a flag
- **Deviation detection** — a transaction more than 5σ above behavioral baseline triggers a flag
- **Auto-escalation** — a high anomaly score automatically escalates to a circuit breaker or reputation penalty

---

## 4-level circuit breakers

| Level | Trigger | Effect | Duration |
|---|---|---|---|
| 0 | Normal | — | — |
| 1 | Anomaly detected | Agent limits reduced to 10% | 1 hour, auto-expire |
| 2 | Multiple anomalies | Agent paused | Owner reactivation required |
| 3 | Aggregate anomaly | Vault paused | Owner + watcher quorum |
| 4 | Emergency | All spending frozen | Timelocked thaw |

Any guardian can trigger level 4. Only the owner can thaw.

---

## Multi-agent coordination security

One vault, many agents — with shared enforcement:

- Each agent carries individual limits, reputation, and state
- Aggregate vault limits bind every agent; no combination of agents can exceed them
- Pausing one agent does not affect others
- Concurrent spends from multiple agents still apply against the aggregate cap

---

## Governance

- **Timelocked admin actions** — `withdraw`, `set_policy`, and `set_agent` enter a 1-hour timelock before taking effect
- **Watcher cancellation** — external monitoring services registered as watchers can cancel any pending timelocked action
- **Guardian freeze** — any guardian can trigger an emergency freeze (level 4) at any time
- **Multisig owner** — admin actions can require M-of-N signatures before entering the timelock

---

## Attestation

The contract stores an expected attestation-proof hash per agent. Every `spend()` call can include a proof; the contract hashes it and compares. A stolen key without the registered proof cannot spend. The full threat model and residual risks are documented in [THREAT_MODEL.md](THREAT_MODEL.md).

---

## Repository layout

```
src/core/engine.ts       pure evaluate(policy, action, ledgerView, ctx) -> Decision; mirror of the contract
src/core/service.ts      FeralGuard: submissions, reservations, approvals, governance, simulation
src/core/reputation.ts   reputation arithmetic and effective limits
src/core/anomaly.ts      burst, drainage, and deviation detection
src/core/circuit.ts      four-level circuit breaker state machine
src/core/money.ts        exact bigint money; parseAmount refuses silent rounding
src/chain/               NEAR Intents (1Click), MPC derivation, secp256k1 recovery, EIP-1559 encoding
src/integrations/        GatedToolbox (paid tool calls) + loop.ts (agent retry logic)
src/demo/scenarios.ts    52-scenario catalogue; single source of truth for CLI, dashboard, and tests
src/demo/prompt-injection.ts  untrusted vendor page, LLM-shaped deterministic planner, injected task
src/cli/agent-attack.ts  npm run agent:attack — the prompt-injection story
src/cli/feral.ts         demo, judge, attack, verify, bench, serve, audit, quote, chainsig, simulate
src/app/                 dependency-free HTTP server + built-in dashboard (no build step)
dashboard/               Next.js product dashboard; proxies /api/* to feral serve
contract/src/lib.rs      Rust vault: 20 checks, reputation, anomaly, breakers, timelocks, 60 tests
contract/res/feral_vault.wasm  the built contract
test/unit/               159 tests: money, YAML, policy, engine, reputation, anomaly, circuit, governance, MPC
test/adversarial/        52 scenario assertions, property-based testing, formal verification
scripts/                 testnet deployment, on-chain denial demo, MPC signing, benchmarks, conformance
docs/                    threat model, testnet evidence, demo script, FAQ
```

---

## Build and test the contract

```bash
cd contract
./build.sh   # produces res/feral_vault.wasm
./test.sh    # runs 60 unit tests (requires a C toolchain for cargo test)
```

---

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy. The full threat model — including trust boundaries, residual risks, and the reasoning behind each guarantee — is in [THREAT_MODEL.md](THREAT_MODEL.md).

---

## Licence

MIT. Built for the **NEAR HACKATHON — AI Security & Defense** track, November 2026.
