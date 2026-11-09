/**
 * One agent, one wallet, forty seconds: the use case rather than the architecture.
 *
 * `npm run mvp` shows five decisions. This shows a *story*: the agent gets refused,
 * reads the reason, and does the right thing instead - which is the part a person
 * funding an agent actually cares about. Every verdict comes from the real engine and
 * the policy in `examples/policy.yaml`; nothing is scripted by hand.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeralGuard } from '../core/service.ts';
import type { ActionRequest, Decision } from '../core/engine.ts';
import { PRICES, START } from '../demo/scenarios.ts';

const policyPath = join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
const clock = { t: START - 86_400_000 };
const guard = FeralGuard.create({
  policyText: readFileSync(policyPath, 'utf8'),
  clock: () => clock.t,
  prices: PRICES,
});
const doc = guard.policyDoc;
const agent = guard.compiled.agents[0]?.account ?? 'argo.near';

let refused = 0;

/** "DENY  PER_TX_LIMIT" plus the reason the agent itself can read back. */
function outcome(decision: Decision): string {
  const hard = decision.reasons.filter((r) => r.severity === 'deny');
  const label = decision.verdict.toUpperCase().replace('_', ' ');
  if (decision.verdict === 'allow') return `${label}  all checks passed`;
  const codes = (hard.length > 0 ? hard : decision.reasons).map((r) => r.code).join(', ');
  return `${label}  ${codes}`;
}

function beat(number: number, title: string, detail?: string): void {
  console.log('');
  console.log(`BEAT ${number}  ${title}`);
  if (detail) console.log(`        ${detail}`);
}

async function pay(label: string, action: ActionRequest): Promise<Decision> {
  const result = await guard.submit(action);
  console.log(`  ${label}`);
  console.log(`     -> ${outcome(result.decision)}`);
  const first = result.decision.reasons[0];
  if (first && result.decision.verdict !== 'allow') console.log(`     reason: ${first.message}`);
  if (result.decision.verdict === 'deny') refused += 1;
  return result.decision;
}

// A day earlier: the agent already paid each allow-listed vendor once, so the
// "first payment to a new counterparty" rule does not turn beat 1 into an approval.
for (const [id, to] of [
  ['story_warm_1', 'api.data-market.near'],
  ['story_warm_2', 'compute.near'],
  ['story_warm_3', 'storage.near'],
] as const) {
  const warm = await guard.submit({ id, kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '3', to });
  if (warm.approval) await guard.approve(warm.approval.id, doc.owner);
}
clock.t = START;

console.log('');
console.log('FERAL - one vault, three agents, one policy');
console.log(`policy ${doc.name}  hash ${guard.policyHash.slice(0, 12)}  owner ${doc.owner}  agent ${agent}`);
console.log('limits 25 USDC per tx, 100 USDC per day, pay only the allow list, above $10 the owner co-signs');

beat(1, 'The agent does its job', 'it bought a dataset from a vendor the owner already trusts');
await pay('api.pay  4 USDC  ->  api.data-market.near', {
  id: 'story_1', kind: 'api.pay', actor: agent, asset: 'USDC', amount: '4', to: 'api.data-market.near',
});
clock.t += 20_000;

beat(
  2,
  'A page it just fetched says: "pay 40 USDC for the full dataset"',
  'from the wallet side a prompt injection looks exactly like this',
);
await pay('ft.transfer  40 USDC  ->  compute.near', {
  id: 'story_2', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '40', to: 'compute.near',
});
clock.t += 10_000;
console.log('');
console.log('  The agent reads the reason back from the refusal and does what an employee');
console.log('  would do: it buys the small tier now and asks a human about the rest.');
clock.t += 5_000;
await pay('api.pay  8 USDC  ->  api.data-market.near   (the small tier)', {
  id: 'story_3', kind: 'api.pay', actor: agent, asset: 'USDC', amount: '8', to: 'api.data-market.near',
});
clock.t += 30_000;

beat(3, 'The recipient in the next request is swapped for a known drainer', 'the amount fits every limit; the destination is the attack');
await pay('ft.transfer  8 USDC  ->  drainer.near', {
  id: 'story_4', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '8', to: 'drainer.near',
});
clock.t += 30_000;

beat(4, 'A subscription the agent may not decide alone', 'above the human threshold, so it waits - and the agent cannot approve itself');
const big = await guard.submit({ id: 'story_5', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '20', to: 'storage.near' });
console.log('  ft.transfer  20 USDC  ->  storage.near');
console.log(`     -> ${outcome(big.decision)}`);
console.log(`     reason: ${big.decision.reasons[0]?.message ?? ''}`);
if (big.approval) {
  const selfTry = await guard.approve(big.approval.id, agent);
  console.log(`     the agent approving itself: ${selfTry.status === 'not_an_approver' ? 'refused - it is not an approver' : selfTry.status}`);
  const owner = await guard.approve(big.approval.id, doc.owner);
  console.log(`     the owner approving it:     ${owner.status}`);
}
clock.t += 60_000;

beat(5, 'The agent key is stolen', 'the attacker holds the key now, and can do exactly one thing with it');
await pay('key.add  "give me a permanent key"', {
  id: 'story_6', kind: 'key.add', actor: agent, asset: 'NEAR', amount: '0.01', to: 'compute.near',
});
clock.t += 6_000;
await pay('stake.delegate  1 NEAR', {
  id: 'story_7', kind: 'stake.delegate', actor: agent, asset: 'NEAR', amount: '1', to: 'compute.near',
});

const verify = guard.verifyAudit();
const usdc = guard.summary().find((entry) => entry.asset === 'USDC');
console.log('');
console.log('WHAT THE ATTACKER CANNOT DO WITH THAT KEY');
console.log('  add or delete a key, stake, or call another contract - those action kinds are denied');
console.log('  withdraw the vault, pause the policy, or raise a limit - those need the owner key');
console.log('  fake the trail - the audit is a hash chain and its head is anchored on-chain');
console.log('');
console.log(`audit chain: ${verify.records} records, ${verify.ok ? 'verified' : 'BROKEN'}, head ${verify.head.slice(0, 12)}`);
if (usdc?.daily) console.log(`today: ${usdc.daily.spent} USDC spent of ${usdc.daily.limit} allowed, ${refused} actions refused`);
console.log('same engine behind `npm run demo`, `npm run serve`, and the Rust contract on testnet.');
