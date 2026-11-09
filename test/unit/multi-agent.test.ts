import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FeralGuard } from '../../src/core/service.ts';
import { PRICES, START, makeGuard, policyText } from '../../src/demo/scenarios.ts';

const policyPath = join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
const shipped = readFileSync(policyPath, 'utf8');

test('the aggregate cap stops a second agent even when both are inside their own limits', async () => {
  const clock = { t: START };
  const text = policyText((doc) => {
    doc.risk = {};
    if (doc.approvals) doc.approvals.thresholdUsd = 1000;
    if (doc.limits.aggregate?.daily) doc.limits.aggregate.daily.USDC = 150;
  });
  const guard = FeralGuard.create({ policyText: text, clock: () => clock.t, prices: PRICES });
  const steps: [string, string, string][] = [
    ['agg_1', 'argo.near', 'compute.near'],
    ['agg_2', 'argo.near', 'storage.near'],
    ['agg_3', 'argo.near', 'api.data-market.near'],
    ['agg_4', 'scout.near', 'compute.near'],
    ['agg_5', 'sentry.near', 'compute.near'],
  ];
  const amounts = ['25', '25', '25', '50', '10'];
  for (let i = 0; i < steps.length; i++) {
    clock.t += 10_000;
    const [id, actor, to] = steps[i];
    const { decision } = await guard.submit({ id, kind: 'ft.transfer', actor, asset: 'USDC', amount: amounts[i], to });
    assert.equal(decision.verdict, 'allow', `${id} should fit: ${JSON.stringify(decision.reasons)}`);
  }
  clock.t += 10_000;
  const argoExtra = await guard.submit({ id: 'agg_6', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '15', to: 'vendor.near' });
  assert.equal(argoExtra.decision.verdict, 'allow', 'the last 15 USDC exactly fills the aggregate');

  clock.t += 10_000;
  const over = await guard.submit({ id: 'agg_7', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '1', to: 'compute.near' });
  assert.equal(over.decision.verdict, 'deny');
  assert.ok(over.decision.reasons.some((reason) => reason.code === 'AGGREGATE_DAILY_LIMIT'));
  assert.equal(guard.getAggregateSpent('USDC', 'day'), 150_000_000n);
});

test('pausing one agent does not affect its siblings', async () => {
  const { guard, clock } = makeGuard();
  guard.pauseAgent('argo.near');
  clock.t += 10_000;
  const argo = await guard.submit({ id: 'pause_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(argo.decision.verdict, 'deny');
  assert.ok(argo.decision.reasons.some((reason) => reason.code === 'AGENT_PAUSED'));
  const scout = await guard.submit({ id: 'pause_2', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(scout.decision.verdict, 'allow');
  guard.unpauseAgent('argo.near');
  clock.t += 10_000;
  const again = await guard.submit({ id: 'pause_3', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(again.decision.verdict, 'allow');
  void shipped;
});
