import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  defaultAnomalyConfig,
  detectBurst,
  detectDeviation,
  detectDrainage,
  freshAnomalyState,
  recordSpend,
} from '../../src/core/anomaly.ts';
import { makeGuard } from '../../src/demo/scenarios.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');

test('burst is five transactions inside the window', () => {
  const config = defaultAnomalyConfig();
  const state = freshAnomalyState(NOW);
  state.burstCount = 4;
  state.burstWindowStart = NOW - 1_000;
  assert.equal(detectBurst(state, NOW, config), false);
  state.burstCount = 5;
  assert.equal(detectBurst(state, NOW, config), true);
  assert.equal(detectBurst(state, NOW + config.burstWindowMs + 1, config), false, 'an old window resets');
});

test('drainage is concentration on one address above the daily fraction', () => {
  const config = defaultAnomalyConfig();
  const state = freshAnomalyState(NOW);
  state.drainageAddress = 'vendor.near';
  state.drainageAmount = 60_000_000n;
  state.drainageTxCount = 3;
  assert.equal(detectDrainage(state, 1_000_000n, 'vendor.near', 100_000_000n, config), true);
  assert.equal(detectDrainage(state, 1_000_000n, 'other.near', 100_000_000n, config), false);
  assert.equal(detectDrainage(state, 1_000_000n, 'vendor.near', 1_000_000_000n, config), false, 'under half the cap is fine');
});

test('deviation is a transaction several times the rolling mean', () => {
  const config = defaultAnomalyConfig();
  const state = freshAnomalyState(NOW);
  state.txCount = 20;
  state.txSizeSum = 20_000_000n; // mean 1 USDC
  state.txSizeSqSum = 20_000_000n ** 2n;
  assert.equal(detectDeviation(state, 6_000_000n, config), true);
  assert.equal(detectDeviation(state, 2_000_000n, config), false);
});

test('recordSpend feeds the baseline and the burst counter', () => {
  const config = defaultAnomalyConfig();
  let state = freshAnomalyState(NOW);
  for (let i = 0; i < 3; i++) state = recordSpend(state, 1_000_000n, 'compute.near', NOW + i * 1_000, config);
  assert.equal(state.txCount, 3);
  assert.equal(state.txSizeSum, 3_000_000n);
  assert.equal(state.burstCount, 3);
});

test('a burst raises the flag, the score and circuit breaker level 1', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 5; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `anomaly_burst_${i}`, kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '1', to: 'compute.near' });
  }
  assert.ok(guard.getAnomalyFlags('scout.near').includes('BURST'));
  assert.ok(guard.getAnomalyScore('scout.near') > 0);
  assert.equal(guard.getCircuitBreakerLevel('scout.near').level, 1);
  assert.equal(guard.getReputation('scout.near'), 85, 'an anomaly costs fifteen points');
});

test('drainage is detected after half the daily cap goes to one address', async () => {
  const { guard, clock } = makeGuard();
  let last = null;
  // 9 USDC stays under the human threshold; eleven payments reach 99 of the
  // 200 USDC daily cap, so the twelfth crosses the 50% concentration line.
  for (let i = 0; i < 12; i++) {
    clock.t += 11 * 60_000;
    last = await guard.submit({ id: `anomaly_drain_${i}`, kind: 'ft.transfer', actor: 'sentry.near', asset: 'USDC', amount: '9', to: 'vendor.near' });
  }
  assert.equal(last?.decision.verdict, 'deny');
  assert.ok(last?.decision.reasons.some((r) => r.code === 'ANOMALY_DRAINAGE'));
  assert.ok(guard.getAnomalyFlags('sentry.near').includes('DRAINAGE'));
  const feed = guard.anomalyFeed();
  assert.ok(feed.some((row) => row.agent === 'sentry.near' && row.flags.includes('DRAINAGE')));
});
