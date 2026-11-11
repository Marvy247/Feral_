# Feral demo

## Narrated walkthrough

**[Watch the 2:42 demo](feral-demo.mp4)** — live testnet denial, reputation
penalty, dashboard, governance and audit. The audio is synthesized; every hash
shown is from the real transactions recorded in [TESTNET.md](TESTNET.md).

## Start with the agent, not the architecture

```bash
npm run agent:attack  # about 15 seconds, no wallet, no keys, no network
```

This is the scene most agent-security demos skip. A vendor page contains a
hidden instruction to pay `attacker.near`. Before spending anything, the
planner prints what it believes the goal is, which page signals it found, its
rationale, and the JSON tool calls it wants to run — the shape a tool-calling
model emits, produced deterministically so the demo is reproducible. It follows
the injection. The first payment is refused, so the planner tries the split
retry the page suggested; that is refused too. Then the planner tries a
`contract.call` whose free-text `reason` says to raise its own limit. It is
refused a third time.

What to watch:

- the planner names the injection, then follows it anyway; no model is called
- the two payment handlers are never called, so the attacker receives nothing
- reputation falls `100 -> 80 -> 70`, and the effective USDC cap falls with it
- the audit chain verifies all three denials
- the planner is deterministic on purpose: a real model would produce the same
  kind of plan, and the firewall does not trust either one

The point is not that the agent is smart. The point is that the agent can be
fully compromised and the vault still refuses.

## Zero-configuration path

```bash
npm run agent:attack # the prompt-injection story, about 15 seconds
npm run demo:judge   # about 60 seconds, no wallet, no keys, no network
npm run attack       # 52 adversarial scenarios, every verdict asserted
npm run verify       # 1000 random actions, invariants checked after each
npm run serve        # dashboard on http://127.0.0.1:8787
```

![npm run demo:judge terminal output](images/terminal.png)

`demo:judge` builds a three-agent vault in memory, runs ten scenes and exits 1 if
any scene produces a different verdict than advertised. It needs Node.js >= 22.6
and nothing else. The scenes are: a clean spend, an overspend, a stranger, a
burst, drainage, the aggregate cap, reputation-adjusted limits, an emergency
freeze and thaw, a watcher cancelling a timelock, and the audit chain (including
detecting a hand-edited record).

## Full narrative

```bash
npm run demo
```

Runs the judge scenes, then adds a recorded NEAR Intents quote (allowed at the
pinned destination, refused when redirected), a policy simulation against the
decisions just made, and a final audit verification.

## Dashboard

There are two frontends over the same guard.

`npm run serve` serves a dependency-free console on `http://127.0.0.1:8787`:

- agent cards: reputation, tier, status, effective limits, anomaly score, breaker
- aggregate daily and monthly budgets across all agents
- the approval queue with approve/reject
- governance: pending timelocks, emergency freeze, thaw
- an anomaly feed and the full decision feed with reputation before/after
- a policy simulation box

The built-in page polls `/api/summary` every few seconds. Every action button
calls the same `FeralGuard` methods as the CLI; there is no second policy path.

The Next.js app in `dashboard/` is the product UI:

```bash
npm run serve        # terminal 1: guard + API on :8787
npm run dashboard    # terminal 2: Next app on :3000
```

![Feral dashboard against a live guard](images/dashboard.png)

It renders real guard state only: agents and effective limits, the hash-chained
decision feed, anomaly flags, aggregate vault budgets, policy and audit heads,
and the approval queue. `/api/*` is rewritten to `FERAL_API_URL` (default
`http://127.0.0.1:8787`), so the browser never needs CORS. Without the guard it
shows an explicit "could not reach the guard" state instead of fake data.

## Benchmarks

```bash
npm run bench
```

Both print p50/p95/p99/max microseconds for the check shapes (allow, overspend,
stranger, denied kind, aggregate, anomaly, breaker).

## Deterministic replay

```bash
npm run verify -- 12345
```

The seed drives a mulberry32 PRNG, so a failing run is reproducible. Invariants:
no denial moves the aggregate ledger, no allow pays a stranger, the aggregate cap
is never exceeded, replay is always refused, reputation and anomaly scores stay
in 0-100.

## Live chain commands

```bash
npm run chain:agent-attack  # on-chain denial of an injected payment
npm run chain:mpc           # real testnet MPC signature over an EIP-1559 tx
feral quote                 # live 1Click quote, gated by destination and slippage
feral chainsig              # derives the MPC address and compares it with the pinned one
```

These are optional; the offline path above does not need RPC. Without network
access each command names the failure and exits non-zero rather than printing a
fake result.

`chain:agent-attack` needs the deployed testnet vault and the restricted agent
key in `data/testnet-roles.json`. It asserts `allowed:false` with
`RECIPIENT_NOT_ALLOWED` and reads the reputation penalty back.

`chain:mpc` derives the owner's Ethereum address for path `ethereum-1`, builds a
real Sepolia EIP-1559 transfer to a neutral recipient, asks
`v1.signer-prod.testnet` to sign its 32-byte hash, then recovers the public key
locally and compares it with the derived key. It writes the signed bytes and the
hashes to `data/testnet-mpc.json`. With `FERAL_BROADCAST=1` it submits the signed
bytes. On 2026-11-11 the signature recovered to
`0x8251684b91a8cc4c95526ea171dc2b07580abdd9`, and the signed 1-wei transfer was
included in Sepolia block `12111331` (tx `0x57198e54...`) with status 1. The
deployed Rust vault does not call the signer itself; this command proves the
signing, verification and broadcast path, not a vault-routed EVM spend.

The recovery and encoding logic has offline tests. The live MPC request uses
public testnet RPC endpoints and is not part of `preflight:offline`; if all
endpoints are unreachable the command reports that and exits 1 rather than
printing a signature.
