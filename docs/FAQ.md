# Feral FAQ

**Can I see it without installing anything?**
Yes. Open the [browser demo](https://raw.githack.com/Marvy247/Feral_/main/docs/demo/index.html), or the committed [docs/demo/index.html](demo/index.html). It is the shipping engine and the 52-scenario catalogue compiled into one static page: run the catalogue, inspect every check, and push actions through a live guard in the console. No wallet, key, server or network. `npm run demo:check` fails if that page is stale.

**Where is the AI?**
`npm run agent:attack` shows it. An agent is asked to summarize a vendor page;
the page contains a hidden instruction to pay `attacker.near`. The planner
prints its goal, the hidden-comment and override signals it detected, a
rationale, and the JSON tool calls it wants to run. It then follows the
injection, retries with a split payment after the refusal, and tries to rewrite
its own limit through a free-text reason. The vault denies all three, the
payment handlers never run, and reputation falls 100 -> 70. The planner is a
deterministic stand-in so the demo works offline and is reproducible; the
firewall treats a real model's output exactly the same way.

**How is this different from a prompt-injection filter or an LLM judge?**
A filter tries to stop the model from believing the instruction. Feral assumes
that already failed. The instruction becomes an ordinary payment request, and
the contract checks it against limits, allowlists, reputation and anomaly state
stored on-chain. Better prompt hygiene is welcome; it is not a security
dependency.

**How is this different from an off-chain spending policy?**
An off-chain policy is only as strong as the process enforcing it. If that
process or its key is compromised, the policy is gone. Feral's agent key can
only call `spend()`, and the vault holding the money recomputes the irreversible
checks from its own storage. The TypeScript engine is a mirror for previews and
tests, not the enforcement point.

**Is this only a spending limit?**
No. The contract holds the money and recomputes its checks on every `spend()`:
per-tx, daily, monthly, aggregate, velocity, counterparties, action kind,
destination pinning, attestation, reputation, anomaly and circuit breakers. Swap
venue, slippage and quote expiry are checked by the off-chain engine before
submission, because the contract never sees the quote; the engine is a mirror
for preview and tests, not the enforcement point.

**Where is the money?**
In the Rust vault (`contract/src/lib.rs`). The agent holds a function-call key
that can call exactly the permitted methods. Withdrawals are owner-only and
timelocked.

**What happens on a refusal?**
Nothing moves. The contract returns the reason code, the service writes an audit
record with the same code, and the agent can read the reason and choose another
legal step. A denial costs ten reputation points.

**Can the agent talk its way past a limit?**
No. The free-text `reason` field is recorded for humans and never parsed. The
LLM is not in the trust path: it can ask for a human, never grant itself one.

**How does reputation change the walls?**
Effective limit = base limit * reputation / 100. Every agent starts at 100.
Denials cost 10, an anomaly flag 15, an executed approval restores 2, and a clean
30-day window restores 20. At 0 the agent is frozen.

**What are the four breaker levels?**
1: limits reduced to 10% for an hour (automatic on a burst). 2: agent paused,
owner reactivates. 3: vault paused, owner plus watcher quorum. 4: all spending
frozen, timelocked thaw.

**What about multiple agents?**
One vault, many agents. Each has its own limits and reputation; the vault has
aggregate daily/monthly caps no combination can exceed. Pausing one agent leaves
the others untouched.

**What is TEE attestation here?**
A hash of the expected attestation proof is registered on-chain. A spend may
carry a proof; the contract checks `sha256(proof)` against the registered hash.
This is a hash commitment, not hardware verification: a real TEE quote would
replace the proof, and the check would stay the same.

**Does the demo need a wallet or network?**
No. The browser demo is a single local HTML page. `npm run agent:attack`,
`npm run demo:judge` and `npm run attack` run in memory, with the recorded policy
and no dependencies. `npm run quote` and `npm run chainsig` use the network when
it is available; the quote falls back to the recorded fixture, while `chainsig`
reports the failure and exits 1.

**Does Feral sign with NEAR chain signatures?**
There is a live signing path: `npm run chain:mpc` builds an EIP-1559 transfer,
asks `v1.signer-prod.testnet` to sign its 32-byte hash, and accepts the result
only if it recovers to the MPC-derived key. On 2026-11-11 the signature
recovered to the derived address, and the signed 1-wei transfer was included in
Sepolia block `12111331` (tx `0x57198e54...`) with status 1. The derived address
was funded for gas; the transfer moved 1 wei to a neutral burn address. The
deployed Rust vault does not call the signer itself yet; it currently guards
NEAR transfers.

**Why TypeScript and Rust?**
The Rust vault is the enforcement point. The TypeScript engine runs the same
checks so a developer can preview a decision in microseconds, simulate a policy
change, and drive the dashboard without a chain.

**Is it audited?**
No external audit has been conducted. The security claims are backed by 186
JavaScript tests, 60 Rust contract tests, 52 adversarial scenarios, 37/37
conformance checks against the live contract, and a formal invariant suite.
The threat model documents every adversary considered and the residual risk of
each mitigation. See [THREAT_MODEL.md](THREAT_MODEL.md).
