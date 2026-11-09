/**
 * The smallest possible demo: five decisions, one command, no network, no keys.
 *
 * `npm run demo` is the full narrative. This one exists so that a person who is not
 * going to read the README can see the product in ten seconds, and so that a judge
 * (or an organiser) sees the same shape in one screen.
 *
 * Policy: examples/policy.yaml, exactly as shipped. Nothing is stubbed.
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
const line = (label: string, index: number, decision: Decision): string => {
  const hard = decision.reasons.filter((r) => r.severity === 'deny').map((r) => r.code);
  const advisory = decision.reasons.length - hard.length;
  let codes: string;
  if (hard.length > 0) codes = hard.join(', ') + (advisory > 0 ? ` (+${advisory} advisory)` : '');
  else if (decision.verdict === 'require_approval') codes = decision.reasons.map((r) => r.code).join(', ');
  else codes = 'all checks passed';
  return `${String(index).padStart(2)}. ${label.padEnd(38)} ${decision.verdict.toUpperCase().padEnd(16)} ${codes}`;
};

// A previous day's payments, so the "first payment to a new vendor" rule does not
// turn the first line into an approval. Two vendors, approved by the owner.
for (const [id, to] of [
  ['mvp_warm_1', 'compute.near'],
  ['mvp_warm_2', 'api.data-market.near'],
] as const) {
  const warm = await guard.submit({ id, kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '3', to });
  if (warm.approval) await guard.approve(warm.approval.id, doc.owner);
}
clock.t = START;

console.log('');
console.log('FERAL - a multi-agent vault with a policy, in five decisions');
console.log(`policy ${doc.name}  hash ${guard.policyHash.slice(0, 12)}  owner ${doc.owner}  agent ${agent}`);
console.log(`limits 1.5 NEAR or 25 USDC per tx, 5 / 100 per day, above $10 a human co-signs`);
console.log('');

const cases: { label: string; action: ActionRequest }[] = [
  {
    label: 'pay compute.near 5 USDC',
    action: { id: 'mvp_1', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '5', to: 'compute.near' },
  },
  {
    label: 'try 26 USDC at once',
    action: { id: 'mvp_2', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '26', to: 'compute.near' },
  },
  {
    label: 'pay a stranger',
    action: { id: 'mvp_3', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '5', to: 'attacker.near' },
  },
  {
    label: 'give itself a new access key',
    action: { id: 'mvp_4', kind: 'key.add', actor: agent, asset: 'NEAR', amount: '0.01', to: 'compute.near' },
  },
  {
    label: 'pay 12 USDC (needs the owner)',
    action: { id: 'mvp_5', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '12', to: 'compute.near' },
  },
];

let index = 1;
let pending: Awaited<ReturnType<typeof guard.submit>> | null = null;
for (const entry of cases) {
  const result = await guard.submit(entry.action);
  console.log(line(entry.label, index++, result.decision));
  if (result.decision.verdict === 'require_approval') pending = result;
  clock.t += 6_000;
}

if (pending?.approval) {
  const selfApproval = await guard.approve(pending.approval.id, agent);
  const ownerApproval = await guard.approve(pending.approval.id, doc.owner);
  console.log(`    the agent approving itself: ${selfApproval.status === 'not_an_approver' ? 'refused' : selfApproval.status}`);
  console.log(`    the owner approving it:     ${ownerApproval.status}`);
}

const verify = guard.verifyAudit();
console.log('');
console.log(`audit chain: ${verify.records} records, ${verify.ok ? 'verified' : 'BROKEN'}, head ${verify.head.slice(0, 12)}`);
console.log('same engine behind `npm run demo`, `npm run serve` and the Rust contract on testnet.');
