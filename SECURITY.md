# Security policy

## What Feral protects

Feral is a vault for autonomous agents. The money lives in the Rust contract; the
agent holds a function-call key that can call `spend` and not much else. Every
spend is judged inside the contract against limits read from contract storage.

The security claim is narrow and testable:

1. No agent can move more than its per-tx, daily, monthly or aggregate limit.
2. No agent can pay outside the counterparty policy.
3. No action id can spend twice.
4. A refusal moves nothing, and it is recorded with a reason code.
5. A drain attempt (burst, drainage, deviation) tightens or freezes the agent
   without a human in the loop.
6. An emergency freeze stops every agent, and a watcher can cancel a timelocked
   administrative action.

## Reporting a vulnerability

Open a private security advisory on the repository. Do not open a public issue
with a working exploit. Include the command, the policy, the action and the
decision you expected; a scenario in `src/demo/scenarios.ts` is the fastest path
to a fix.

## Scope

In scope: `contract/src/lib.rs`, `src/core/engine.ts`, `src/core/policy.ts`,
`src/core/service.ts`, `src/core/ledger.ts`, `src/core/anomaly.ts`,
`src/core/reputation.ts`, `src/core/circuit.ts`, and the dashboard endpoints.

Out of scope: the demo policy values, the recorded quote fixture, and any
deployment script that talks to testnet.

## Known limitations

- **Not externally audited.** The security claims are backed by 186 JavaScript
  tests, 60 Rust contract tests, 52 adversarial scenarios, and 37/37 conformance
  checks against the live contract. See [THREAT_MODEL.md](THREAT_MODEL.md) for
  the full analysis of each adversary and residual risk.
- **TEE attestation is a hash check.** The contract compares `sha256(proof)` with
  a registered hash. It does not verify a hardware quote; a real TEE integration
  would replace the proof, not the check. The `spend()` interface is designed to
  support that upgrade without a signature change.
- **Time is block time.** Rolling windows use the chain's timestamp. An operator
  who controls block production can choose it, as with any on-chain window.
- **The off-chain engine is a mirror.** A bug there can produce a wrong preview;
  it cannot move funds. Only the contract decides.
- **Reputation is policy, not identity.** A new agent starts at 100. Sybil
  resistance comes from the owner registering agents, not from the score.
- **The dashboard is a local service.** It keeps state in memory and has no
  authentication; do not expose it to the internet.
