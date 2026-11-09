import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { makeGuard } from '../../src/demo/scenarios.ts';

const HOUR = 3_600_000;

test('a timelock cannot execute before its delay', () => {
  const { guard } = makeGuard();
  const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: '200' });
  assert.throws(() => guard.executeTimelock(id), /not yet executable/);
});

test('the owner can execute a timelock once the delay has passed', () => {
  const { guard, clock } = makeGuard();
  const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: '200' });
  clock.t += HOUR + 1_000;
  assert.doesNotThrow(() => guard.executeTimelock(id, 'alice.near'));
});

test('a watcher can cancel a suspicious timelock', () => {
  const { guard } = makeGuard();
  const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: '200' });
  guard.cancelTimelock(id, 'dave.near');
  assert.throws(() => guard.executeTimelock(id, 'alice.near'), /cancelled/);
});

test('a stranger cannot cancel a timelock', () => {
  const { guard } = makeGuard();
  const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: '200' });
  assert.throws(() => guard.cancelTimelock(id, 'stranger.near'), /not owner, multisig or watcher/);
});

test('a guardian freezes, a stranger cannot, and the owner thaws', () => {
  const { guard } = makeGuard();
  assert.throws(() => guard.emergencyFreeze('stranger.near'), /not a guardian/);
  guard.emergencyFreeze('dave.near');
  assert.equal(guard.getCircuitBreakerLevel().level, 4);
  guard.thaw('alice.near');
  assert.equal(guard.getCircuitBreakerLevel().level, 0);
});

test('a multisig member can thaw a frozen vault', () => {
  const { guard } = makeGuard();
  guard.emergencyFreeze('dave.near');
  guard.thaw('bob.near');
  assert.equal(guard.getCircuitBreakerLevel().level, 0);
});

test('watchers and guardians can be registered at runtime', () => {
  const { guard } = makeGuard();
  guard.registerWatcher('watchtower.near');
  guard.registerGuardian('guardian.near');
  assert.ok(guard.compiled.watchers.includes('watchtower.near'));
  assert.ok(guard.compiled.guardians.includes('guardian.near'));
  guard.emergencyFreeze('guardian.near');
  assert.equal(guard.getCircuitBreakerLevel().level, 4);
});
