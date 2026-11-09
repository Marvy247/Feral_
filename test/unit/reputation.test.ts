import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  applyAnomaly,
  applyApproval,
  applyCleanSpend,
  applyDenial,
  applyRecovery,
  defaultReputationConfig,
  effectiveLimit,
  isFrozen,
} from '../../src/core/reputation.ts';
import { makeGuard } from '../../src/demo/scenarios.ts';

const DAY_MS = 86_400_000;

test('reputation arithmetic is clamped and exact', () => {
  const config = defaultReputationConfig();
  assert.equal(config.initial, 100);
  assert.equal(applyCleanSpend(100, config), 100, 'clean spend is capped');
  assert.equal(applyCleanSpend(50, config), 51);
  assert.equal(applyDenial(100, config), 90);
  assert.equal(applyDenial(5, config), 0, 'denial is floored at zero');
  assert.equal(applyAnomaly(100, config), 85);
  assert.equal(applyApproval(90, config), 92);
  assert.equal(applyRecovery(50, config), 70);
  assert.equal(applyRecovery(95, config), 100);
});

test('an agent at zero is frozen, and effective limits scale with reputation', () => {
  const config = defaultReputationConfig();
  assert.equal(isFrozen(0, config), true);
  assert.equal(isFrozen(1, config), false);
  assert.equal(effectiveLimit(100_000_000n, 100), 100_000_000n);
  assert.equal(effectiveLimit(100_000_000n, 40), 40_000_000n);
  assert.equal(effectiveLimit(100_000_000n, 0), 0n);
});

test('every agent starts at the policy reputation', () => {
  const { guard } = makeGuard();
  for (const agent of guard.getAgents()) assert.equal(guard.getReputation(agent.account), 100);
});

test('a denial costs ten points, a clean spend earns one', async () => {
  const { guard, clock } = makeGuard();
  const denied = await guard.submit({ id: 'rep_deny', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' });
  assert.equal(denied.decision.verdict, 'deny');
  assert.equal(guard.getReputation('argo.near'), 90);

  clock.t += 10_000;
  const clean = await guard.submit({ id: 'rep_clean', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(clean.decision.verdict, 'allow');
  assert.equal(guard.getReputation('argo.near'), 91, 'a clean spend earns one point back');
});

test('reputation-adjusted limits are enforced before the base limit is reached', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 5; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `rep_drop_${i}`, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' });
  }
  assert.equal(guard.getReputation('argo.near'), 50);
  const effective = guard.getEffectiveLimits('argo.near').assets.USDC;
  assert.equal(effective?.perTx, '12.5');
  clock.t += 6_000;
  const result = await guard.submit({ id: 'rep_span', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '13', to: 'compute.near' });
  assert.equal(result.decision.verdict, 'deny');
  assert.ok(result.decision.reasons.some((r) => r.code === 'PER_TX_LIMIT'));
});

test('an agent at reputation zero is frozen', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 10; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `rep_zero_${i}`, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' });
  }
  assert.equal(guard.getReputation('argo.near'), 0);
  const result = await guard.submit({ id: 'rep_frozen', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(result.decision.verdict, 'deny');
  assert.ok(result.decision.reasons.some((r) => r.code === 'REPUTATION_FROZEN'));
});

test('reputation recovers after a clean 30-day window', async () => {
  const { guard, clock } = makeGuard();
  const start = clock.t;
  for (let i = 0; i < 5; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `rep_recover_${i}`, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' });
  }
  assert.equal(guard.getReputation('argo.near'), 50);
  clock.t = start + 30 * DAY_MS;
  const recovered = await guard.submit({ id: 'rep_recovered', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(recovered.decision.verdict, 'allow');
  assert.equal(guard.getReputation('argo.near'), 70);
});
