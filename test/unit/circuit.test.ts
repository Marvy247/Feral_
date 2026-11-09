import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  currentLevel,
  isExpired,
  limitFraction,
  normalState,
  shouldFreezeVault,
  shouldPauseAgent,
  shouldReduceLimits,
  triggerLevel1,
  triggerLevel2,
  triggerLevel3,
  triggerLevel4,
} from '../../src/core/circuit.ts';
import { makeGuard } from '../../src/demo/scenarios.ts';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const HOUR = 3_600_000;

test('level 1 reduces limits for one hour, then expires', () => {
  const state = triggerLevel1(normalState(), 'burst', HOUR, NOW);
  assert.equal(state.level, 1);
  assert.equal(currentLevel(state, NOW), 1);
  assert.equal(shouldReduceLimits(state, NOW), true);
  assert.equal(limitFraction(state, NOW), 0.1);
  assert.equal(isExpired(state, NOW + HOUR + 1), true);
  assert.equal(currentLevel(state, NOW + HOUR + 1), 0);
  assert.equal(limitFraction(state, NOW + HOUR + 1), 1);
});

test('levels 2, 3 and 4 escalate pause and freeze', () => {
  const two = triggerLevel2(normalState(), 'repeat anomaly', NOW);
  assert.equal(two.level, 2);
  assert.equal(shouldPauseAgent(two, NOW), true);
  assert.equal(shouldFreezeVault(two, NOW), false);

  const three = triggerLevel3(normalState(), 'aggregate anomaly', NOW);
  assert.equal(three.level, 3);
  assert.equal(shouldFreezeVault(three, NOW), false, 'level 3 pauses the vault');

  const four = triggerLevel4(normalState(), 'emergency', NOW);
  assert.equal(four.level, 4);
  assert.equal(shouldFreezeVault(four, NOW), true);
});

test('a burst trips the agent breaker and it expires with the clock', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 5; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `cb_burst_${i}`, kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '1', to: 'compute.near' });
  }
  assert.equal(guard.getCircuitBreakerLevel('scout.near').level, 1);
  clock.t += HOUR + 1_000;
  assert.equal(guard.getCircuitBreakerLevel('scout.near').level, 0);
});

test('an emergency freeze blocks every agent and a thaw restores spending', async () => {
  const { guard, clock } = makeGuard();
  guard.emergencyFreeze('dave.near');
  assert.equal(guard.getCircuitBreakerLevel().level, 4);

  const blocked = await guard.submit({ id: 'cb_frozen', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(blocked.decision.verdict, 'deny');
  assert.ok(blocked.decision.reasons.some((r) => r.code === 'EMERGENCY_FREEZE'));

  guard.thaw('alice.near');
  clock.t += 10_000;
  const allowed = await guard.submit({ id: 'cb_thawed', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(allowed.decision.verdict, 'allow');
});

test('a manual level 2 pauses one agent without touching its siblings', async () => {
  const { guard, clock } = makeGuard();
  guard.triggerCircuitBreaker('argo.near', 2, 'manual review');
  clock.t += 10_000;
  const paused = await guard.submit({ id: 'cb_agent', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(paused.decision.verdict, 'deny');
  assert.ok(paused.decision.reasons.some((r) => r.code === 'AGENT_PAUSED'));
  const sibling = await guard.submit({ id: 'cb_sibling', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  assert.equal(sibling.decision.verdict, 'allow');
});
