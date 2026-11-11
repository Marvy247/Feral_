# Feral vault contract

The enforcement point for autonomous agent spending on NEAR. When an agent calls
`spend()`, the contract recomputes every limit, reputation score, counterparty
rule, and anomaly state from its own storage — with no trust in the caller.
Funds move only if all checks pass. A refusal returns `allowed: false` with a
machine-readable reason code, persists the reputation and anomaly penalty, and
emits a NEP-297 `deny` event. The contract does **not** panic on a denial: a
NEAR panic reverts state writes, which would make limit probing free and discard
the penalty.

The agent's key can call `spend` and nothing else. It cannot add keys, delete
keys, withdraw, pause, or modify policy. The contract is the second wall; the
NEAR key permission layer is the first.

## Build and test

```bash
cd contract
./build.sh     # cargo build --release --target wasm32-unknown-unknown -> res/feral_vault.wasm
./test.sh      # cargo test
```

The test suite has 60 `#[test]` functions and no network access. `near-sdk` is
pinned to `=5.7.0` so the crate builds with the toolchain in this repository.

## Methods

| Method | Who | What |
|---|---|---|
| `new(owner)` | deployer | creates the vault; the owner is also the first guardian |
| `add_agent(account, tier, limits, attestation_hash?)` | owner / multisig | registers an agent and its per-asset limits |
| `remove_agent(account)` | owner / multisig | removes an agent |
| `rotate_agent_key(old, new)` | owner / multisig | rotates an agent account |
| `pause_agent(account)` / `unpause_agent(account)` | owner / multisig | per-agent switch |
| `register_attestation(account, hash)` | owner / multisig | pins an attestation-proof hash |
| `trigger_circuit_breaker(account, level, reason)` | owner / multisig | sets an agent breaker level |
| `set_policy(policy_hash, allowlist, denylist, strict, aggregate_limits, allowed_actions, denied_actions)` | owner / multisig | installs the policy |
| `set_aggregate_limits(limits)` | owner / multisig | vault-wide caps |
| `set_paused(paused)` | owner / multisig | vault pause (level 3) |
| `set_intent_policy(venues, max_slippage_bps, allowed_destinations)` | owner / multisig | stores intent policy; destinations are enforced, slippage is informational on-chain |
| `set_agent(account)` | owner / multisig | legacy single-agent helper |
| `spend(asset_id, amount, to, action_kind, attestation_proof?, decision_hash?, destination?)` | agent | runs the evaluation; returns `{allowed, reason, reputation, ...}`, moves funds only on allow |
| `check(agent, asset_id, amount, to, action_kind, attestation_proof?, destination?)` | anyone (view) | `"allow"` or `"deny:<REASON>"` without moving funds |
| `simulate_policy(limits, allowlist, asset_id, amount, to, action_kind)` | anyone (view) | evaluates proposed per-agent limits |
| `request_approval(asset_id, amount, to)` / `approve_approval(id)` / `reject_approval(id)` | agent / approver | human co-sign, re-checked on execution |
| `propose_timelock(action_type, params, delay_ns?)` / `cancel_timelock(id)` / `execute_timelock(id)` | owner, watcher | timelocked admin actions |
| `emergency_freeze()` / `thaw()` | guardian / owner | level 4 freeze and thaw |
| `register_guardian(account)` / `register_watcher(account)` | owner / multisig | governance roles |
| `set_multisig(members, threshold)` / `set_timelock_delay(delay_ns)` | owner / multisig | M-of-N and delay configuration |
| `withdraw(asset_id, amount, to)` | owner / multisig | owner withdrawal |
| `check_reputation(account)` / `check_anomaly(account)` | anyone (view) | reputation and anomaly state |
| `get_config()` / `get_agents()` / `get_vault_breaker()` / `get_timelocks()` / `get_pending_approvals()` | anyone (view) | inspection |
| `get_aggregate_usage(asset_id)` / `get_usage(agent, asset_id)` | anyone (view) | rolling usage |
| `get_decision_count()` / `get_last_decision_hash()` / `get_owner()` / `is_paused()` | anyone (view) | audit head and flags |

## The checks, in order

Seventeen of these run inside the contract. Slippage and quote expiry (17-18)
cannot be enforced there: the contract never sees the quote, so the off-chain
engine checks them before `spend()`. The contract does restrict swaps to
`near-intents` and pins the destination, because those are the irreversible
parts.

1. vault emergency freeze
2. vault circuit breaker (level 3)
3. agent circuit breaker (level 2)
4. agent paused
5. attestation-proof hash (if registered)
6. amount positive and exact
7. action kind allow/deny
8. per-tx limit (reputation-adjusted)
9. rolling daily limit
10. rolling monthly limit
11. aggregate vault limit
12. counterparty deny list
13. counterparty allow list (strict)
14. burst window (5 tx / 60s)
15. minimum interval between transactions
16. intent venue (only `near-intents` on-chain)
17. slippage ceiling (off-chain)
18. quote expiry (off-chain)
19. destination address pinning
20. reputation floor

## Reason codes

`EMERGENCY_FREEZE`, `VAULT_PAUSED`, `AGENT_PAUSED`, `ATTESTATION_REQUIRED`,
`ATTESTATION_MISMATCH`, `APPROVAL_REQUIRED`, `ACTION_NOT_ALLOWED`, `NO_LIMIT`,
`NON_POSITIVE_AMOUNT`, `PER_TX_LIMIT`, `DAILY_LIMIT`, `MONTHLY_LIMIT`,
`AGGREGATE_DAILY_LIMIT`, `AGGREGATE_MONTHLY_LIMIT`, `RECIPIENT_DENIED`,
`RECIPIENT_NOT_ALLOWED`, `RATE_LIMIT_INTERVAL`, `ANOMALY_BURST`,
`ANOMALY_DRAINAGE`, `ANOMALY_DEVIATION`, `DESTINATION_NOT_ALLOWED`,
`REPUTATION_FROZEN`, `INSUFFICIENT_BALANCE`, `PAUSED`.

`simulate_policy` and `check` can also return `AGENT_NOT_FOUND`.

## Storage and arithmetic

Amounts are `u128` in the asset's smallest unit. There are no floats. Limits are
read from contract storage on every call; nothing is cached between calls, so a
changed limit takes effect immediately. Decisions are linked by hash: each
decision stores the previous decision hash, and `get_audit_head()` returns the
head a monitor can anchor off-chain.
