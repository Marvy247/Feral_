# Feral FAQ

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
No. `npm run demo:judge` and `npm run attack` run in memory, with the recorded
policy and no dependencies. `npm run quote` and `npm run chainsig` use the
network when it is available and fall back to the recorded fixture for the quote.

**Why TypeScript and Rust?**
The Rust vault is the enforcement point. The TypeScript engine runs the same
checks so a developer can preview a decision in microseconds, simulate a policy
change, and drive the dashboard without a chain.

**Is it audited?**
No. This is hackathon software. The security claims are backed by tests and the
threat model, not by an external audit. Do not put real funds in it.
