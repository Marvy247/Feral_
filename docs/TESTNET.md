# Testnet evidence

This file records the on-chain deployment of the Feral vault. Every hash here
was read from a real NEAR testnet transaction or block. Nothing is fabricated.

**Network:** testnet  
**RPC:** https://rpc.testnet.fastnear.com  
**Explorer:** https://testnet.nearblocks.io  

---

## Accounts

```
contract/owner  aa0cfa9951c95da04c563952ca56c79d078e10fb73c8987e66bed2d4202d38fb
vendor          286c8e53816ad4e98002b1b1327a9940f9e29d032af62e80ecf073be50aac1ab
agent           2859d143b9a3aa45dfb0704c8af2674b3b9c2d63e2afab1659a9e40ce491d615
```

All three are implicit accounts (hex of the ed25519 public key), funded via the
testnet faucet. The agent ends up with a single function-call key scoped to
`spend` on the vault contract. It cannot add keys, delete keys, withdraw, pause,
or call any other method.

---

## Transactions

| Step | Method | Transaction hash | Explorer |
|---|---|---|---|
| Deploy contract | `deployContract` | `BdH6yyLJJP6S7e5kN6miCZfbTDSikcDvYaiag9L2rZ8U` | [view](https://testnet.nearblocks.io/txns/BdH6yyLJJP6S7e5kN6miCZfbTDSikcDvYaiag9L2rZ8U) |
| Initialize vault | `new(owner, agent)` | `VfXq2aTha93uqX1Mw6FyPDVbr1cKxg5Hp6x94DmVRbK` | [view](https://testnet.nearblocks.io/txns/VfXq2aTha93uqX1Mw6FyPDVbr1cKxg5Hp6x94DmVRbK) |
| Add function-call key | `addKey(spend only)` | `QErm94LZNULkrZKMcR3ZPSeTAHdTrPx9PgBpu3rh5N6` | [view](https://testnet.nearblocks.io/txns/QErm94LZNULkrZKMcR3ZPSeTAHdTrPx9PgBpu3rh5N6) |
| Delete full-access key | `deleteKey` | `HcduMfcK32DvHFCeSW9YVqy5Pfkskmg59pnmh1gyevPB` | [view](https://testnet.nearblocks.io/txns/HcduMfcK32DvHFCeSW9YVqy5Pfkskmg59pnmh1gyevPB) |
| Register agent | `add_agent(limits)` | `BFwF4uJEVxuN8rS37JvLwRWMwH1LrJXjJRig6y5w1XFf` | [view](https://testnet.nearblocks.io/txns/BFwF4uJEVxuN8rS37JvLwRWMwH1LrJXjJRig6y5w1XFf) |
| Install policy | `set_policy(...)` | `FLkbBdSvPZPXpSxhtVKMnHH7a6gs7Xzm5NrrF8GGaXno` | [view](https://testnet.nearblocks.io/txns/FLkbBdSvPZPXpSxhtVKMnHH7a6gs7Xzm5NrrF8GGaXno) |
| Allowed spend | `spend(0.25 NEAR)` | `3iHNfcpBwRJxWhTCSUD5Ba8d3AHH4dfTGpKA4yDc7F56` | [view](https://testnet.nearblocks.io/txns/3iHNfcpBwRJxWhTCSUD5Ba8d3AHH4dfTGpKA4yDc7F56) |
| Redeploy fixed vault | `deployContract` | `yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43V` | [view](https://testnet.nearblocks.io/txns/yhsp8BZnczRzyWUn4CxfaKyMbjPizE9BJ6G5x2GL43V) |
| Denied spend | `spend(1.5 NEAR)` | `GLZrPiETJ1Vedu8D8pUHP8jmYNcfJpnZFPha5RknWerS` | [view](https://testnet.nearblocks.io/txns/GLZrPiETJ1Vedu8D8pUHP8jmYNcfJpnZFPha5RknWerS) |
| Top up vault | `transfer(2 NEAR)` | `9v88dLb5hgwEmHpE4DCxyaH3c4WyQPPyEQ7Ccba1MTVE` | [view](https://testnet.nearblocks.io/txns/9v88dLb5hgwEmHpE4DCxyaH3c4WyQPPyEQ7Ccba1MTVE) |
| Reset agent state | `remove_agent` | `8UErGQRdQLpSEAMDzaJKy9sdHRTakFdybxTcSstMhPVg` | [view](https://testnet.nearblocks.io/txns/8UErGQRdQLpSEAMDzaJKy9sdHRTakFdybxTcSstMhPVg) |
| Re-register agent | `add_agent(limits)` | `HKwKWEv4oe31vPaQULdJjQ9egw4wDN97Kuy7h7fqh9NU` | [view](https://testnet.nearblocks.io/txns/HKwKWEv4oe31vPaQULdJjQ9egw4wDN97Kuy7h7fqh9NU) |
| Clean spend after reset | `spend(0.25 NEAR)` | `GmLfRWTrdthrHSBhDcvHCfWLW91HEd6mNUd7EX7a6Grq` | [view](https://testnet.nearblocks.io/txns/GmLfRWTrdthrHSBhDcvHCfWLW91HEd6mNUd7EX7a6Grq) |
| Denied spend after reset | `spend(1.5 NEAR)` | `B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU` | [view](https://testnet.nearblocks.io/txns/B7i3Q1Yx8qA84yTpfpmbyDLYaM3Li5HZwF49JdQRqxtU) |
| Prompt-injection denial | `spend(25 USDC intent)` | `HGhtZPxANEpus1wiDV9XmxtBHvDtQfoVqxR1PS4CC419` | [view](https://testnet.nearblocks.io/txns/HGhtZPxANEpus1wiDV9XmxtBHvDtQfoVqxR1PS4CC419) |

The denied spend (1.5 NEAR over the 1 NEAR per-tx cap) returned:
```json
{ "allowed": false, "reason": "PER_TX_LIMIT", "reputation": 90, "decision_count": 1 }
```
The NEP-297 `deny` event carried the reason code. **No funds moved**, and because
the call returns a value instead of panicking, the state writes survived:
`check_reputation` read **100 -> 90** afterwards and `deny_count` became 1.
This is deliberate. A NEAR panic reverts all state, so the earlier design made
limit probing free and threw away the penalty it claimed to apply. The demo was
run again after the conformance suite, with the same result (`B7i3Q1...`).

The contract code itself is part of the vault account's storage stake, so only
about 0.2 NEAR was spendable at first. A 2 NEAR top-up (`9v88dL...`) restored
working room. The vault is testnet-only and holds no real value.

The key restriction was verified: the agent tried to call `set_paused`, which
its function-call key does not allow. The chain responded:
```
Access key does not allow method set_paused
```

The latest denial is the live prompt-injection path. The planner read the hidden
instruction and submitted a 25 USDC payment to `attacker.near`. The vault
returned `allowed:false`, `reason:"RECIPIENT_NOT_ALLOWED"`; reputation moved
`90 -> 80`, no funds moved, and the decision hash chain did not advance. The
transaction is `HGhtZPx...` in the table above.

---

## MPC signature (Sepolia)

`npm run chain:mpc` ran on 2026-11-11 against `v1.signer-prod.testnet`, path
`ethereum-1`, chain ID `11155111` (Sepolia). It derived:

```
public key   secp256k1:53wV8KQDLZaWZxMXT8oJpQHuA2mvtAjqg11P6EF8RZzQxVPD4KocojgruC9MqHuyDTybW1NTZmmZ3cseEFKzYJcH
EVM address  0x8251684b91a8cc4c95526ea171dc2b07580abdd9
```

The signing hash was
`0d5df463208c2b57e249bf82680de08007bf7dc2ebd9f3dcf1223b25a25801d5`.
The MPC returned `r=233c5f0c541bab72...`, `s=46922ba4e6766653...`, `v=1`; the
local recovery produced the same public key, so the signature was accepted by
the script. The signed EIP-1559 transfer was 1 wei to the neutral Sepolia burn
address `0x000000000000000000000000000000000000dEaD`, with hash
`0x57198e54ffbce12bfbd11ae8fae8c76251be62d2bffa4afdcb4201ffe1725dfc`.

Sepolia included it in block `12111331` with `status: 1`, `gasUsed: 21000` and
`effectiveGasPrice: 1000000022` wei. The derived address was funded for gas, so
this is a successful end-to-end EVM transfer, not just a signature. The
deployed Rust vault still does not call the signer itself.

An earlier 1-wei attempt to the fixture destination
`0x583ddbf02324f75c3963c45686d52afaf2368c2f` was included at block `12111286`
but returned `status: 0`; no value moved, so it is not counted as the
successful spend. The broadcast proof uses the neutral burn address.

---

## Policy hash

```
f26cbce96678957a274b3036c9d819d64476b58f91124b08d9d6550f27e2b3d9
```

This is the sha256 of the canonical policy document installed by `set_policy`.
The contract stores this hash on-chain and refuses `set_policy` from anyone
other than the owner. Every on-chain `spend` event carries this hash.

---

## Current on-chain state

Read with `view` calls after the redeploy, the denial, and a conformance run:

```json
{
  "agent_reputation": 80,
  "effective_per_tx_near": "0.8 NEAR",
  "decision_count": 20,
  "last_decision_hash": "93f996e2d07d6ed1df0d2c5d2b8689b49b70ea139328e767bf3729bd0cfc1ff4",
  "vault_breaker_level": 0,
  "agent_tier": "worker"
}
```

The 20 decisions are the accepted spends, the denial probes and the conformance
run. The conformance run left the agent at reputation 12; `npm run chain:demo`
then removes and re-adds the agent, which clears its per-agent reputation, usage
and anomaly state, and re-proves 100 -> 90. The later on-chain injection denial
(`HGhtZPx...`) took it from 90 to 80, so the live state is 80 with a 0.8 NEAR
effective per-tx limit. The vault's deviation detector is live; a fresh transfer
well outside the learned baseline is denied (`ANOMALY_DEVIATION`). The immutable
transactions above are the audit record.

---

## Conformance suite

Ran `npm run chain:conformance` against the live contract after the
non-reverting denial redeploy.

```
37/37 conformance checks passed against the live contract
```

All checks verify that `check()` and `spend()` agree on the same reason codes
for every denial, that the on-chain hash chain advances only on an accepted
spend, and that the agent key cannot reach the owner's surface. Because a
denial now persists its penalty, this suite lowers the agent's reputation. Run
it on a disposable vault, or run `npm run chain:demo` afterwards, which
re-registers the agent and resets the per-agent state.

---

## What this proves

1. The contract is deployed and initialized on testnet.
2. The agent's full-access key was deleted; only a function-call key for
   `spend` remains.
3. A legitimate spend (0.25 NEAR, within limits, to the allow-listed vendor)
   succeeded and moved funds.
4. An overspend (1.5 NEAR, above the 1 NEAR per-tx cap) was denied on-chain
   with `PER_TX_LIMIT`. The contract enforces the limit; no off-chain process
   can bypass it.
5. The denial persisted: reputation fell from 100 to 90 and `deny_count` rose,
   even though no funds moved.
6. The agent key itself cannot call owner methods — the NEAR key permission
   layer is the first wall, the contract logic is the second.
7. `check()` and `spend()` agree: they call the same `evaluate()` function
   and return the same reason codes.
8. A refused spend does not advance the on-chain decision hash chain.
9. The agent's reputation, tier, circuit breaker, and anomaly state are
   readable on-chain.
10. The vault breaker is at level 0 (normal operation).
11. A prompt-injected payment is denied on-chain (`RECIPIENT_NOT_ALLOWED`),
    costs reputation, and moves nothing.
12. The MPC path produces a signature that recovers to the derived key, and a
    signed 1-wei EVM transfer was included on Sepolia with status 1.
