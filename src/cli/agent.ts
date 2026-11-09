/**
 * An agent with a budget, doing a job, in a loop that reacts to refusals.
 *
 * Three tasks, three outcomes: the agent adapts and succeeds, the agent gives up
 * because the wall has nothing to do with price, and the agent is stopped correctly
 * until a human decides. Every attempt goes through the same policy and the same audit
 * chain; nothing here can widen a limit.
 *
 *   npm run agent
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeralGuard } from '../core/service.ts';
import { GatedToolbox } from '../integrations/toolbox.ts';
import { formatTrace, runTask, type PlanStep } from '../integrations/loop.ts';
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

const toolbox = new GatedToolbox(guard)
  .register({
    name: 'premium_dataset',
    vendor: 'compute.near',
    price: { asset: 'USDC', amount: '40' },
    handler: () => ({ rows: 1_000_000 }),
  })
  .register({
    name: 'small_dataset',
    vendor: 'compute.near',
    price: { asset: 'USDC', amount: '8' },
    handler: () => ({ rows: 50_000 }),
  })
  .register({
    name: 'cheap_marketplace',
    vendor: 'drainer.near',
    price: { asset: 'USDC', amount: '5' },
    handler: () => ({ rows: 10 }),
  })
  .register({
    name: 'storage_plan',
    vendor: 'storage.near',
    price: { asset: 'USDC', amount: '20' },
    handler: () => ({ bucket: 'cold' }),
  });

// A day earlier the agent already paid compute.near once, so the plan below is not
// stopped by the "first payment to a new counterparty" rule.
const warm = await guard.submit({ id: 'agent_warm_1', kind: 'api.pay', actor: agent, asset: 'USDC', amount: '3', to: 'compute.near' });
if (warm.approval) await guard.approve(warm.approval.id, doc.owner);
clock.t = START;

console.log('');
console.log('FERAL - an agent with a budget, in a loop');
console.log(`agent ${agent}  owner ${doc.owner}  policy ${doc.name}`);
console.log('the agent never edits the policy; it reads reason codes and chooses another legal move');

const plan: PlanStep[] = [
  { tool: 'premium_dataset', why: 'the full dataset the task asks for' },
  { tool: 'small_dataset', why: 'the same vendor has a cheaper tier that fits the per-tx cap' },
];

clock.t += 10 * 60_000;
const first = await runTask(toolbox, 'fetch the training dataset', plan);
console.log('');
console.log(formatTrace(first));

clock.t += 10 * 60_000;
const second = await runTask(toolbox, 'buy rows from the cheap marketplace', [
  { tool: 'cheap_marketplace', why: 'it is 5 USDC and looks like a bargain' },
]);
console.log('');
console.log(formatTrace(second));
console.log('  the agent did not try to work around a denied recipient: a recipient allow list');
console.log('  is not a price problem, so there is no cheaper route to try.');

clock.t += 10 * 60_000;
const third = await runTask(toolbox, 'subscribe to cold storage', [
  { tool: 'storage_plan', why: 'the plan costs more than the agent may approve alone' },
]);
console.log('');
console.log(formatTrace(third));
const pending = third.attempts[0];
if (pending && third.status === 'blocked_on_human') {
  const approvals = guard.snapshot().approvals ?? [];
  const first_pending = approvals.find((approval) => approval.status === 'pending');
  if (first_pending) {
    const decided = await guard.approve(first_pending.id, doc.owner);
    console.log(`  the owner approved it: ${decided.status}. The spend executed at approval time,`);
    console.log('  so the agent has nothing to retry - and nothing it could have done on its own.');
  }
}

const verify = guard.verifyAudit();
const usdc = guard.summary().find((entry) => entry.asset === 'USDC');
console.log('');
console.log(`audit chain: ${verify.records} records, ${verify.ok ? 'verified' : 'BROKEN'}`);
if (usdc?.daily) console.log(`today: ${usdc.daily.spent} USDC spent of ${usdc.daily.limit} allowed`);
console.log('three tasks: adapted, gave up, and waited for a human - none of them crossed a limit.');
