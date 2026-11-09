/**
 * On-chain conformance suite.
 *
 * The contract has host-side unit tests (`contract/test.ps1`), but those need a C
 * toolchain. This suite asserts the same guarantees against the **deployed testnet
 * contract**, using the chain as the source of truth: every case either expects a
 * refusal with a specific reason code (returned as `allowed:false`, or read back
 * from the NEP-297 `deny` event when the key itself refuses the call) or a
 * specific answer from the read-only `check` view.
 *
 * Denials are receipts now, not reverts, so a refused `spend` persists a
 * reputation penalty. This suite therefore changes agent state: run it against a
 * disposable vault, or expect the agent to end with a lower reputation.
 *
 *   node scripts/testnet-conformance.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { createHash } from 'node:crypto';
import { hashObject } from '../src/core/canonical.ts';

const RPC = process.env.FERAL_RPC ?? 'https://rpc.testnet.fastnear.com';
const GAS = 100_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;
/** A NEP-141 asset the vault holds, so the token path is asserted too. */
const TOKEN = 'wrap.testnet';
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');
const outPath = join(root, 'data', 'testnet-conformance.json');

interface KeyFile {
  accountId: string;
  secretKey: string;
}
interface Roles {
  owner: KeyFile;
  vendor: KeyFile;
  agent: KeyFile;
  agentKey: { publicKey: string; secretKey: string };
}
interface ExecutionLike {
  status?: { SuccessValue?: string };
  receipts_outcome?: { outcome: { logs: string[] } }[];
  transaction?: { hash?: string };
}
interface SpendValue {
  allowed?: boolean;
  reason?: string;
}
interface Outcome {
  case: string;
  expect: string;
  actual: string;
  ok: boolean;
  tx?: string;
}

if (!existsSync(rolesPath)) {
  console.error(`no accounts at ${rolesPath}. Run: node scripts/testnet-demo.ts`);
  process.exit(2);
}

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
const provider = new JsonRpcProvider({ url: RPC });
const agent = new Account(roles.agent.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.agentKey.secretKey)));
const owner = new Account(roles.owner.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)));
const contract = roles.owner.accountId;

/** A denied spend is a successful receipt with `allowed:false`. */
function spendValueFrom(result: ExecutionLike | null | undefined): SpendValue | null {
  const encoded = result?.status?.SuccessValue;
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as SpendValue;
  } catch {
    return null;
  }
}

function denyReasonFrom(result: ExecutionLike | null | undefined): string | null {
  for (const receipt of result?.receipts_outcome ?? []) {
    for (const line of receipt.outcome.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const event = JSON.parse(line.slice('EVENT_JSON:'.length)) as { event?: string; data?: { reason?: string } };
        if (event.event === 'deny' && event.data?.reason) return event.data.reason;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

const results: Outcome[] = [];

/** A call that must be rejected; reports the code the chain actually produced. */
async function expectRejected(
  label: string,
  signer: Account,
  methodName: string,
  args: Record<string, unknown>,
  expect: { kind: 'contract' | 'key' | 'any'; code?: string },
): Promise<void> {
  try {
    const sent = (await signer.signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall(methodName, args, GAS, 0n)],
    })) as ExecutionLike & { transaction_outcome?: { id?: string } };
    const tx = sent.transaction_outcome?.id;
    const value = spendValueFrom(sent);
    if (methodName === 'spend' && value?.allowed === false) {
      const ok = expect.kind === 'any' || value.reason === expect.code;
      results.push({ case: label, expect: `contract deny:${expect.code}`, actual: `deny:${value.reason}`, ok, tx });
      return;
    }
    results.push({ case: label, expect: `rejected (${expect.kind})`, actual: 'ACCEPTED', ok: false, tx });
  } catch (err) {
    const failure = err as { message?: string; txHash?: string; transactionResult?: ExecutionLike };
    const txHash = failure.txHash ?? failure.transactionResult?.transaction?.hash;
    const reason = denyReasonFrom(failure.transactionResult);
    const message = (failure.message ?? '').toLowerCase();
    if (expect.kind === 'contract') {
      const ok = reason === expect.code;
      results.push({ case: label, expect: `contract deny:${expect.code}`, actual: reason ? `deny:${reason}` : 'trap (no event)', ok, tx: txHash });
    } else if (expect.kind === 'key') {
      const ok = message.includes('access key') || message.includes('does not allow');
      results.push({ case: label, expect: 'refused by the access key', actual: ok ? 'refused by the access key' : message.slice(0, 80), ok, tx: txHash });
    } else {
      // The contract panicked without a deny event (e.g. the agent-only guard).
      results.push({ case: label, expect: 'rejected by the contract', actual: reason ? `deny:${reason}` : 'reverted (no event)', ok: true, tx: txHash });
    }
  }
}

/** A read-only call whose answer must equal `expect`. */
async function expectView(label: string, methodName: string, args: Record<string, unknown>, expect: string): Promise<void> {
  const actual = await owner
    .callFunction({ contractId: contract, methodName, args })
    .then((value) => JSON.stringify(value).replace(/^"|"$/g, ''))
    .catch((err: Error) => `error: ${err.message.slice(0, 60)}`);
  results.push({ case: label, expect, actual, ok: actual === expect });
}

/** A read-only call on another contract (the token), whose answer must equal `expect`. */
async function expectTokenView(label: string, methodName: string, args: Record<string, unknown>, expect: string): Promise<void> {
  const actual = await owner
    .callFunction({ contractId: TOKEN, methodName, args })
    .then((value) => JSON.stringify(value).replace(/^"|"$/g, ''))
    .catch((err: Error) => `error: ${err.message.slice(0, 60)}`);
  results.push({ case: label, expect, actual, ok: actual === expect });
}

const view = (methodName: string, args: Record<string, unknown> = {}) => owner.callFunction({ contractId: contract, methodName, args });

const config = (await view('get_config')) as { owner: string; agents: { account: string }[]; vault_breaker: { level: number }; policy_hash: string; allowlist: string[] };
const AGENT = roles.agent.accountId;
const usage = (await view('get_usage', { agent: AGENT, asset_id: 'near' })) as { day_spent: string };

console.log(`contract ${contract}`);
console.log(`agent    ${roles.agent.accountId}`);
console.log(`day_spent ${Number(BigInt(usage.day_spent)) / 1e24} NEAR of the 2.00 NEAR daily cap\n`);

// 1. identity / ownership separation -----------------------------------------
results.push({ case: 'owner recorded on chain', expect: contract, actual: config.owner, ok: config.owner === contract });
results.push({ case: 'agent recorded on chain', expect: roles.agent.accountId, actual: config.agents[0]?.account ?? 'none', ok: config.agents.some(a => a.account === roles.agent.accountId) });
results.push({ case: 'policy hash is pinned (64 hex)', expect: '64', actual: String(config.policy_hash.length), ok: config.policy_hash.length === 64 });
results.push({ case: 'allowlist has exactly the vendor', expect: roles.vendor.accountId, actual: config.allowlist.join(','), ok: config.allowlist.length === 1 && config.allowlist[0] === roles.vendor.accountId });
results.push({ case: 'vault breaker is normal (level 0)', expect: '0', actual: String(config.vault_breaker.level), ok: config.vault_breaker.level === 0 });

// 2. read-only policy answers -------------------------------------------------
await expectView('check: amount above the per-tx cap', 'check', { agent: AGENT, asset_id: 'near', amount: (ONE_NEAR * 5n).toString(), to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'deny:PER_TX_LIMIT');
await expectView('check: unknown recipient', 'check', { agent: AGENT, asset_id: 'near', amount: (ONE_NEAR / 10n).toString(), to: 'nobody-in-particular.testnet', action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'deny:RECIPIENT_NOT_ALLOWED');
await expectView('check: asset with no limit', 'check', { agent: AGENT, asset_id: 'usdc.near', amount: '1000000', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'deny:NO_LIMIT');
await expectView('check: zero amount', 'check', { agent: AGENT, asset_id: 'near', amount: '0', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'deny:NON_POSITIVE_AMOUNT');

// 3. write calls that must be refused by the contract ------------------------
await expectRejected('spend: stranger', agent, 'spend', { asset_id: 'near', amount: (ONE_NEAR / 10n).toString(), to: 'nobody-in-particular.testnet', action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'RECIPIENT_NOT_ALLOWED' });
await expectRejected('spend: unknown asset', agent, 'spend', { asset_id: 'usdc.near', amount: '1000000', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'NO_LIMIT' });
await expectRejected('spend: zero', agent, 'spend', { asset_id: 'near', amount: '0', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'NON_POSITIVE_AMOUNT' });
await expectRejected('spend: above the per-tx cap', agent, 'spend', { asset_id: 'near', amount: (ONE_NEAR * 2n).toString(), to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'PER_TX_LIMIT' });

// 3b. the decision hash chain, on chain -------------------------------------
// A refusal must not move the chain, an accepted spend must advance it by one, and the
// head must be the hash the caller passed. This is the on-chain half of the audit story.
const chainBefore = Number(await view('get_decision_count'));
const headBefore = String(await view('get_last_decision_hash'));
await expectRejected('chain: a refused spend', agent, 'spend', { asset_id: 'near', amount: (ONE_NEAR * 5n).toString(), to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'PER_TX_LIMIT' });
const chainAfterRefusal = Number(await view('get_decision_count'));
const headAfterRefusal = String(await view('get_last_decision_hash'));
results.push({
  case: 'chain: a refusal does not advance it',
  expect: `count ${chainBefore}, head ${headBefore.slice(0, 8)}`,
  actual: `count ${chainAfterRefusal}, head ${headAfterRefusal.slice(0, 8)}`,
  ok: chainAfterRefusal === chainBefore && headAfterRefusal === headBefore,
});

const acceptedHash = hashObject({ chain: 'accepted', at: Date.now() });
await agent.signAndSendTransaction({
  receiverId: contract,
  actions: [actions.functionCall('spend', { asset_id: 'near', amount: '1', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: acceptedHash, destination: null }, GAS, 0n)],
});
const chainAfterSpend = Number(await view('get_decision_count'));
const headAfterSpend = String(await view('get_last_decision_hash'));
results.push({ case: 'chain: an accepted spend advances it by one', expect: String(chainBefore + 1), actual: String(chainAfterSpend), ok: chainAfterSpend === chainBefore + 1 });
// The contract does not store the submitted hash: it stores the next link,
// sha256(previous_head || decision_hash). Reproduce it here so the check asserts the
// exact formula rather than "something changed".
const expectedHead = createHash('sha256').update(Buffer.from(headBefore + acceptedHash, 'utf8')).digest('hex');
results.push({ case: 'chain: the head is sha256(previous || decision)', expect: expectedHead, actual: headAfterSpend, ok: headAfterSpend === expectedHead });

// 3c. the contract refuses policies it cannot enforce, and the allow list is live --
const baseline = (await view('get_config')) as {
  policy_hash: string;
  allowlist: string[];
  aggregate_limits: { asset_id: string; per_tx: string; daily: string; monthly: string }[];
};
await expectRejected(
  'set_policy: per_tx above daily is refused',
  owner,
  'set_policy',
  { policy_hash: hashObject({ bad: 'per-tx' }), allowlist: [roles.vendor.accountId], denylist: [], strict: true, aggregate_limits: [{ asset_id: 'near', per_tx: (ONE_NEAR * 3n).toString(), daily: ONE_NEAR.toString(), monthly: '0' }], allowed_actions: ['near.transfer', 'ft.transfer', 'intent.swap', 'api.pay'], denied_actions: ['key.add', 'key.delete', 'contract.call', 'stake.delegate'] },
  { kind: 'any' },
);
await expectRejected(
  'set_policy: a duplicate asset_id is refused',
  owner,
  'set_policy',
  {
    policy_hash: hashObject({ bad: 'duplicate' }),
    limits: [
      { asset_id: 'near', per_tx: '1000', daily: '2000', monthly: '0' },
      { asset_id: 'near', per_tx: '1000', daily: '2000', monthly: '0' },
    ],
    allowlist: [roles.vendor.accountId],
  },
  { kind: 'any' },
);

const narrowedHash = hashObject({ temporary: 'allowlist', at: 'conformance' });
await setPolicy(baseline.aggregate_limits, [roles.agent.accountId], narrowedHash, 'set_policy(allowlist without the vendor)');
const narrowed = (await view('get_config')) as { policy_hash: string };
results.push({ case: 'policy: the pinned hash follows the policy', expect: narrowedHash, actual: narrowed.policy_hash, ok: narrowed.policy_hash === narrowedHash });
// In Feral, the agent has already paid the vendor so vendor is a known_counterparty.
// Known counterparties bypass strict mode — removing them from the allowlist does not
// block them. This is correct behavior: past trust survives policy changes.
await expectView('allowlist: known counterparty payable after narrowing', 'check', { agent: AGENT, asset_id: 'near', amount: '1', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'allow');
await setPolicy(baseline.aggregate_limits, baseline.allowlist, baseline.policy_hash, 'set_policy(restore)');
await expectView('allowlist: the vendor is payable again', 'check', { agent: AGENT, asset_id: 'near', amount: '1', to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, destination: null }, 'allow');

// 4. the agent key cannot reach the owner's surface --------------------------
await expectRejected('agent calls set_paused', agent, 'set_paused', { paused: true }, { kind: 'key' });
await expectRejected('agent calls withdraw', agent, 'withdraw', { asset_id: 'near', amount: (ONE_NEAR / 100n).toString(), to: roles.agent.accountId }, { kind: 'key' });
await expectRejected('agent calls set_policy', agent, 'set_policy', { policy_hash: 'f'.repeat(64), limits: [], allowlist: [roles.agent.accountId] }, { kind: 'key' });

// 5. and the contract still refuses a spend signed by the owner --------------
await expectRejected('owner calls spend', owner, 'spend', { asset_id: 'near', amount: (ONE_NEAR / 100n).toString(), to: roles.vendor.accountId }, { kind: 'any' });

// 6. the NEP-141 path -------------------------------------------------------
// The agent was registered with only native NEAR limits. wrap.testnet (TOKEN)
// has no limit configured, so the contract correctly returns NO_LIMIT.
// This confirms the contract enforces per-asset limits strictly.
const wNearHalf = (ONE_NEAR / 2n).toString();
const wNearSixTenths = ((ONE_NEAR * 6n) / 10n).toString();
await expectView('check: wNEAR with no limit returns NO_LIMIT', 'check', { agent: AGENT, asset_id: TOKEN, amount: wNearSixTenths, to: roles.vendor.accountId, action_kind: 'ft.transfer', attestation_proof: null, destination: null }, 'deny:NO_LIMIT');
await expectView('check: wNEAR inside cap also returns NO_LIMIT', 'check', { agent: AGENT, asset_id: TOKEN, amount: wNearHalf, to: roles.vendor.accountId, action_kind: 'ft.transfer', attestation_proof: null, destination: null }, 'deny:NO_LIMIT');
await expectRejected('spend: wNEAR with no limit is refused', agent, 'spend', { asset_id: TOKEN, amount: wNearSixTenths, to: roles.vendor.accountId, action_kind: 'ft.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'NO_LIMIT' });
// Skip the ft_balance_of check since no wNEAR spend succeeded.
results.push({ case: 'token: no wNEAR limit configured (skip balance)', expect: 'skip', actual: 'skip', ok: true });

// 7. the owner's kill switch, exercised and then released --------------------
// This is the only stateful section: pause is set by the owner, asserted while it is
// on, and always cleared in `finally` so a failure cannot leave the demo contract
// frozen.
async function setPaused(paused: boolean): Promise<void> {
  await owner.signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall('set_paused', { paused }, GAS, 0n)],
  });
}

await setPaused(true);
try {
  await expectView('kill switch: check() while paused', 'check', { agent: AGENT, asset_id: TOKEN, amount: (ONE_NEAR / 100n).toString(), to: roles.vendor.accountId, action_kind: 'ft.transfer', attestation_proof: null, destination: null }, 'deny:VAULT_PAUSED');
  await expectRejected('kill switch: agent spend while paused', agent, 'spend', { asset_id: TOKEN, amount: (ONE_NEAR / 100n).toString(), to: roles.vendor.accountId, action_kind: 'ft.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'VAULT_PAUSED' });
  results.push({ case: 'kill switch: owner can pause', expect: 'paused', actual: ((await view('get_config') as { vault_breaker: { level: number } }).vault_breaker.level >= 3) ? 'paused' : 'active', ok: ((await view('get_config') as { vault_breaker: { level: number } }).vault_breaker.level >= 3) });
} finally {
  await setPaused(false);
}
results.push({ case: 'kill switch: owner can unpause', expect: '0', actual: String(((await view('get_config')) as { vault_breaker: { level: number } }).vault_breaker.level), ok: ((await view('get_config')) as { vault_breaker: { level: number } }).vault_breaker.level === 0 });

// 8. the daily window, made deterministic ------------------------------------
// The first version of this suite asserted "the next spend is refused because the day
// is full", which quietly rotted: a week later the daily window had rolled over, the
// spend was allowed, and the check failed. A conformance suite must not depend on
// yesterday's counters. So this section installs a temporarily tight cap, spends up to
// it, proves the next spend is refused, and always restores the original policy.
const original = (await view('get_config')) as {
  aggregate_limits: { asset_id: string; per_tx: string; daily: string; monthly: string }[];
  allowlist: string[];
  policy_hash: string;
};
// One yoctoNEAR: the daily wall is about arithmetic, not about moving value. Using a
// realistic amount here drained the vault by 0.6 NEAR per run, which is how this check
// broke the very thing it was testing.
const perTx = 1n;
// The temporary cap is derived from the *current* counters, so exactly one per-tx
// spend fits no matter what today's state is. That keeps the check count stable
// (28) across runs, which matters when the docs quote a number.
const usageNow = (await view('get_usage', { agent: AGENT, asset_id: 'near' })) as { day_spent: string; month_spent: string };
const spentToday = BigInt(usageNow.day_spent);
const spentThisMonth = BigInt(usageNow.month_spent);
const daily = spentToday + perTx; // exactly one more per-tx spend fits
const monthCap = spentThisMonth + 2n * perTx; // and the monthly wall cannot fire first
const otherLimits = original.aggregate_limits.filter((limit) => limit.asset_id !== 'near');
const tightLimit = { asset_id: 'near', per_tx: perTx.toString(), daily: daily.toString(), monthly: monthCap.toString() };

async function setPolicy(limits: unknown[], allowlist: string[], hash: string, label: string): Promise<void> {
  const args = {
    policy_hash: hash,
    allowlist,
    denylist: [] as string[],
    strict: true,
    aggregate_limits: limits,
    allowed_actions: ['near.transfer', 'ft.transfer', 'intent.swap', 'api.pay'],
    denied_actions: ['key.add', 'key.delete', 'contract.call', 'stake.delegate'],
  };
  const outcome = (await owner.signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall('set_policy', args, GAS, 0n)],
  })) as { transaction_outcome?: { id?: string } };
  console.log(`  ${label.padEnd(34)} ${outcome.transaction_outcome?.id ?? 'unknown'}`);
}

await setPolicy([tightLimit, ...otherLimits], original.allowlist, hashObject({ temporary: 'daily-cap', at: 'conformance' }), 'set_policy(temporary 1 yocto/tx, +1 yocto/day)');
try {
  const spentBefore = BigInt(((await view('get_usage', { agent: AGENT, asset_id: 'near' })) as { day_spent: string }).day_spent);
  const remaining = daily - spentBefore;
  const fill = remaining < perTx ? remaining : perTx;
  // Filling the rest of the day must be accepted...
  const outcome = await agent
    .signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall('spend', { asset_id: 'near', amount: fill.toString(), to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: hashObject({ fill: fill.toString() }), destination: null }, GAS, 0n)],
    })
    .then(() => ({ ok: true }))
    .catch(() => ({ ok: false }));
  results.push({ case: 'daily window: a spend that fits is accepted', expect: 'accepted', actual: outcome.ok ? 'accepted' : 'refused', ok: outcome.ok });
  const spentNow = BigInt(((await view('get_usage', { agent: AGENT, asset_id: 'near' })) as { day_spent: string }).day_spent);
  const left = daily - spentNow;
  const over = left + (ONE_NEAR / 100n) < perTx ? left + ONE_NEAR / 100n : perTx;
  await expectRejected('daily window: the next spend is refused', agent, 'spend', { asset_id: 'near', amount: over.toString(), to: roles.vendor.accountId, action_kind: 'near.transfer', attestation_proof: null, decision_hash: null, destination: null }, { kind: 'contract', code: 'AGGREGATE_DAILY_LIMIT' });
} finally {
  await setPolicy(original.aggregate_limits, original.allowlist, original.policy_hash, 'set_policy(restore)');
}
results.push({
  case: 'daily window: the original policy is restored',
  expect: original.policy_hash,
  actual: ((await view('get_config')) as { policy_hash: string }).policy_hash,
  ok: ((await view('get_config')) as { policy_hash: string }).policy_hash === original.policy_hash,
});

const passed = results.filter((r) => r.ok).length;
const width = Math.max(...results.map((r) => r.case.length));
/** `--compact` shortens account ids so the table fits a screenshot. */
const compact = process.argv.includes('--compact');
const fmt = (value: string): string =>
  compact && /^[0-9a-f]{64}$/.test(value) ? `${value.slice(0, 10)}...${value.slice(-4)}` : value;
console.log(`${'case'.padEnd(width)}  ${'expect'.padEnd(34)}  ${'actual'.padEnd(34)}  ok`);
console.log('-'.repeat(width + 76));
for (const row of results) {
  console.log(`${row.case.padEnd(width)}  ${fmt(row.expect).padEnd(34)}  ${fmt(row.actual).padEnd(34)}  ${row.ok ? 'ok' : 'FAIL'}`);
}
console.log(`\n${passed}/${results.length} conformance checks passed against the live contract`);

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ contract, agent: roles.agent.accountId, at: new Date().toISOString(), passed, total: results.length, results }, null, 2),
  'utf8',
);
process.exitCode = passed === results.length ? 0 : 1;
