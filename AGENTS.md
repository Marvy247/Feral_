# AGENTS.md

Orientation for an AI agent (or a reviewer) working in this repository. Feral is
the security layer for autonomous money on NEAR: a Rust vault that enforces
limits, reputation, anomaly detection, circuit breakers, multi-agent aggregate
limits and timelocked governance on-chain, plus a pure TypeScript mirror that
adds the quote checks the contract cannot see.

## Verify it in 60 seconds, without installing anything

```bash
npm run test:all      # full suite, no network, no node_modules needed
npm run agent:attack  # prompt injection -> denied payment, split retry, policy rewrite
npm run attack        # 52 escape attempts, every verdict asserted
npm run demo:judge    # 10 scenes, zero config, no wallet
npm run verify        # 1000 random actions, invariants checked after each
npm run serve         # dashboard on :8787 (also dependency-free)
```

The only npm dependency (`near-api-js`) is a devDependency used by `scripts/`, so
the commands above work on a bare checkout. Node.js >= 22.6 runs the TypeScript
directly.

## Where things are

| Path | What lives there |
|---|---|
| `contract/src/lib.rs` | the Rust vault: 20 checks, reputation, anomaly, breakers, timelocks, approvals, 60 tests |
| `src/core/engine.ts` | pure `evaluate(policy, action, ledgerView, ctx) -> Decision`, the mirror of the contract |
| `src/core/policy.ts` | v2 policy schema, strict validation, compilation, hash pinning |
| `src/core/service.ts` | `FeralGuard`: submissions, reservations, approvals, governance, simulation, persistence |
| `src/core/reputation.ts` | reputation arithmetic and effective limits |
| `src/core/anomaly.ts` | burst, drainage, deviation detection |
| `src/core/circuit.ts` | four-level breaker state machine |
| `src/core/money.ts` | exact `bigint` money; `parseAmount` refuses silent rounding |
| `src/demo/scenarios.ts` | 52-scenario catalogue; single source of truth for CLI, dashboard, tests |
| `src/demo/prompt-injection.ts` | untrusted vendor page, deterministic planner, injected task through `GatedToolbox` |
| `src/chain/secp256k1.ts` | dependency-free public-key recovery; verifies MPC signatures |
| `src/chain/evm.ts` | RLP + EIP-1559 encoding, MPC signature parsing |
| `src/cli/agent-attack.ts` | `npm run agent:attack`; the injection narrative |
| `src/cli/feral.ts` | `demo`, `demo:judge`, `attack`, `verify`, `bench`, `serve`, `audit`, `quote`, `chainsig`, `simulate`, `reputation`, `anomaly`, `evaluate` |
| `src/app/` | dashboard server and page (no build step) |
| `dashboard/` | Next.js product dashboard; proxies `/api/*` to `feral serve`, holds no policy logic |
| `contract/res/feral_vault.wasm` | the built contract |
| `scripts/testnet-agent-attack.ts` | live on-chain denial of an injected payment |
| `scripts/testnet-mpc-sign.ts` | live MPC signature + local recovery check (no broadcast by default) |

## Rules that keep the project honest

1. **No floats in money.** Amounts are `bigint` minor units; use `src/core/money.ts`.
2. **The engine stays pure.** No I/O, no clock, no network inside `evaluate()`.
   Time and prices are injected.
3. **The LLM is not in the trust path.** Rules may only tighten (escalate to a
   human). The free-text `reason` field is for the audit trail, never parsed.
4. **One source of truth for attacks.** Add a scenario to
   `src/demo/scenarios.ts` with an expected verdict; the tests fail if the engine
   disagrees.
5. **Don't claim what you didn't run.** `docs/TESTNET.md` records the testnet
   deployment; update it only from an actual run, and keep hashes, not prose.
6. **ASCII-only CLI output.** Windows consoles default to cp1251 and turn
   punctuation into garbage.

## Common tasks

- New policy rule: `engine.ts` check + `REASON` code + a scenario in
  `scenarios.ts` + a unit test. Mirror it in `contract/src/lib.rs` if it is a
  fund-moving rule.
- New dashboard endpoint: `src/app/server.ts`, JSON errors only (`{ error }`).
- New command in the docs: `npm run audit:docs` is part of preflight, so the
  script must exist in `package.json` before the README mentions it.
- Rebuild the contract: `cd contract && ./build.sh`.
- Run the contract tests: `cd contract && ./test.sh`.

## Do not

- Commit anything from `data/` except `data/fixtures/`.
- Push, publish, or submit the project on the user's behalf.
- Weaken a test to make a change pass; fix the behaviour instead.
