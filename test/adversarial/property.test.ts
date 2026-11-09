/**
 * Property tests: the same walls, attacked by a thousand random actions instead
 * of fifty hand-written ones.
 *
 * The catalogue proves the walls exist. These tests prove the walls cannot be
 * walked around by luck - every invariant below is checked after every random
 * action, so a bug that only shows up on an unusual amount or mix of payments
 * has a chance to surface.
 *
 * Deterministic on purpose: the seed is fixed, so a failure is reproducible, and
 * the run is identical on every machine and in CI.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { FeralGuard } from '../../src/core/service.ts';
import type { ActionRequest } from '../../src/core/engine.ts';
import { makeGuard } from '../../src/demo/scenarios.ts';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

const USDC_AMOUNTS = ['0.01', '1', '5', '9.99', '10', '12', '20', '25'] as const;
const NEAR_AMOUNTS = ['0.001', '0.5', '1', '1.49', '2'] as const;

function usdcView(guard: FeralGuard): { spent: bigint; reserved: bigint; limit: bigint; remaining: bigint } {
  const entry = guard.summary().find((row) => row.asset === 'USDC');
  assert.ok(entry?.daily, 'the test policy must have a USDC daily limit');
  return {
    spent: BigInt(Math.round(Number(entry.daily.spent) * 1_000_000)),
    reserved: BigInt(Math.round(Number(entry.daily.reserved) * 1_000_000)),
    limit: BigInt(Math.round(Number(entry.daily.limit) * 1_000_000)),
    remaining: BigInt(Math.round(Number(entry.daily.remaining) * 1_000_000)),
  };
}

test('a thousand random actions never break the invariants', async () => {
  const random = mulberry32(0x5eed);
  const { guard, clock } = makeGuard();
  const doc = guard.policyDoc;
  const agent = guard.compiled.agents[0]?.account ?? 'argo.near';
  const allowed = ['compute.near', 'api.data-market.near', 'storage.near'];
  const strangers = ['drainer.near', 'attacker.near', 'randomer-one.near', 'randomer-two.near'];
  const kinds = ['ft.transfer', 'ft.transfer', 'ft.transfer', 'near.transfer', 'key.add', 'stake.delegate'] as const;

  let allowedSoFar = 0;
  let deniedSoFar = 0;
  let escalatedSoFar = 0;

  for (let index = 0; index < 1000; index += 1) {
    const before = usdcView(guard);
    const useUsdc = random() < 0.7;
    const to = random() < 0.95 ? pick(random, allowed) : pick(random, strangers);
    const action: ActionRequest = {
      id: `fuzz_${index}`,
      kind: random() < 0.92 ? 'ft.transfer' : pick(random, kinds),
      actor: agent,
      asset: useUsdc ? 'USDC' : 'NEAR',
      amount: random() < 0.92
        ? (useUsdc ? pick(random, USDC_AMOUNTS) : pick(random, NEAR_AMOUNTS))
        : useUsdc ? '26' : '60',
      to,
    };

    const { decision } = await guard.submit(action);
    const after = usdcView(guard);
    const amountMinor = BigInt(Math.round(Number(action.amount) * 1_000_000));

    // 1. Denials move nothing: no budget spent, no budget reserved.
    if (decision.verdict === 'deny') {
      deniedSoFar += 1;
      assert.equal(after.spent, before.spent, `deny at ${index} changed spent: ${action.amount} ${action.asset} to ${to}`);
      assert.equal(after.reserved, before.reserved, `deny at ${index} changed reserved`);
    }

    // 2. An allowed payment to a stranger is impossible while the policy is strict.
    if (decision.verdict === 'allow') {
      allowedSoFar += 1;
      assert.ok(allowed.includes(to) || doc.counterparties?.mode !== 'strict', `allow at ${index} paid a stranger: ${to}`);
    }

    // 3. Spending never exceeds the daily limit, and never moves by more than the amount.
    assert.ok(after.spent <= after.limit, `spent ${after.spent} exceeded limit ${after.limit} at ${index}`);
    const delta = after.spent - before.spent;
    assert.ok(delta >= 0n, `spent went backwards at ${index}`);
    if (delta > 0n) {
      assert.ok(action.asset === 'USDC', `non-USDC action changed the USDC budget at ${index}`);
      assert.ok(delta <= amountMinor, `budget moved ${delta} for an action of ${amountMinor} at ${index}`);
    }

    // 4. Reserved budget plus spent budget never exceeds the limit either.
    assert.ok(after.spent + after.reserved <= after.limit, `spent+reserved above the limit at ${index}`);

    // 5. A replayed id cannot be turned into a different answer.
    const again = guard.preview({ ...action });
    assert.equal(again.verdict, 'deny', `replaying ${action.id} was not denied`);
    assert.ok(again.reasons.some((reason) => reason.code === 'REPLAY'), `replay at ${index} was refused without REPLAY`);

    if (decision.verdict === 'require_approval') escalatedSoFar += 1;
    // 11 minutes: five transfers per hour, below the six-per-hour cap, so the
    // run reaches the budget walls instead of stopping at the velocity wall.
    clock.t += 11 * 60_000;
  }

  // The run has to be interesting: a fuzz that only ever hits one branch proves little.
  // The fuzz is attack-weighted: the approval line and per-day caps stop most
  // spends, and ten denials freeze the agent. The point is that the invariants
  // held on every one of the 1000 actions, not that many were allowed.
  assert.ok(allowedSoFar > 0, 'the fuzz never produced a single allowed action');
  assert.ok(deniedSoFar > 10, `only ${deniedSoFar} denied actions`);
  assert.ok(escalatedSoFar > 0, 'the fuzz never reached the approval queue');
});

test('a wallet that only pays one vendor stops exactly at the daily cap', async () => {
  const { guard, clock } = makeGuard();
  const doc = guard.policyDoc;
  const agent = guard.compiled.agents[0]?.account ?? 'argo.near';
  // The first payment to a counterparty is escalated by design, so warm it up first.
  const warm = await guard.submit({ id: 'drain_warm', kind: 'ft.transfer', actor: agent, asset: 'USDC', amount: '3', to: 'compute.near' });
  if (warm.approval) await guard.approve(warm.approval.id, doc.owner);

  let last = usdcView(guard).spent;
  let sawCap = false;
  for (let index = 0; index < 20; index += 1) {
    // One payment every 11 minutes keeps the velocity limits out of the way, so the
    // only wall left in this test is the daily cap.
    clock.t += 11 * 60_000;
    const { decision } = await guard.submit({
      id: `drain_fuzz_${index}`,
      kind: 'ft.transfer',
      actor: agent,
      asset: 'USDC',
      amount: '9',
      to: 'compute.near',
    });
    const view = usdcView(guard);
    assert.ok(view.spent >= last, 'the spent counter went backwards');
    assert.ok(view.spent <= view.limit, 'the daily cap was exceeded');
    if (decision.verdict === 'deny') {
      sawCap = true;
      assert.ok(
        decision.reasons.some((reason) => reason.code === 'DAILY_LIMIT' || reason.code === 'ANOMALY_DRAINAGE'),
        `a deny at ${index} was not a budget wall: ${decision.reasons.map((r) => r.code).join(', ')}`,
      );
    }
    last = view.spent;
  }
  assert.ok(last > 0n, 'nothing was spent at all');
  assert.ok(sawCap, 'the loop never reached the daily cap');
});
