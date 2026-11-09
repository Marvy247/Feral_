/**
 * Adversarial suite.
 *
 * Layer 1: the shared catalogue in src/demo/scenarios.ts, every verdict and
 * reason code asserted case by case.
 * Layer 2: stateful attacks that need history - draining budgets, replaying ids,
 * stacking approvals, tampering with the audit chain, swapping the policy.
 *
 * Run: npm run test:all
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';
import { AuditLog } from '../../src/core/audit.ts';
import { FeralGuard } from '../../src/core/service.ts';
import type { ActionRequest } from '../../src/core/engine.ts';
import {
  CATEGORIES,
  CATALOGUE,
  LAB,
  PRICES,
  START,
  makeGuard,
  policyText,
  runScenario,
} from '../../src/demo/scenarios.ts';

const base = (id: string, overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id,
  kind: 'ft.transfer',
  actor: 'argo.near',
  asset: 'USDC',
  amount: '5',
  to: 'compute.near',
  ...overrides,
});

test('the catalogue is big enough to be a claim, not a demo', () => {
  assert.ok(CATALOGUE.length >= 50, `expected at least 50 scenarios, got ${CATALOGUE.length}`);
  for (const category of CATEGORIES) {
    assert.ok(CATALOGUE.some((scenario) => scenario.category === category), `no scenario covers ${category}`);
  }
  assert.ok(CATALOGUE.some((scenario) => scenario.expect === 'allow'), 'a catalogue with no allowed actions proves nothing');
  assert.ok(CATALOGUE.some((scenario) => scenario.expect === 'require_approval'));
  assert.ok(CATALOGUE.some((scenario) => scenario.expect === 'deny'));
});

test('every scenario has a unique id and a stated wall', () => {
  const ids = CATALOGUE.map((scenario) => scenario.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const scenario of CATALOGUE) {
    assert.ok(scenario.wall.length > 0, `scenario ${scenario.id} has no wall`);
    assert.ok(scenario.description.length > 0, `scenario ${scenario.id} has no description`);
  }
});

test('no decision reports the same reason code twice', async () => {
  const offenders: string[] = [];
  for (const entry of CATALOGUE) {
    const result = await runScenario(entry);
    const seen = new Set<string>();
    const repeated = result.codes.filter((code) => (seen.has(code) ? true : (seen.add(code), false)));
    if (repeated.length > 0) offenders.push(`${entry.name}: ${repeated.join(', ')}`);
  }
  assert.deepEqual(offenders, []);
});

test('two different escalations carry two different codes', async () => {
  const tight = policyText((doc) => {
    doc.velocity = {};
    if (doc.agents?.[0]) doc.agents[0].limits.daily.USDC = 5;
    if (doc.limits.daily) doc.limits.daily.USDC = 5;
  });
  const guard = FeralGuard.create({ policyText: tight, clock: () => START, prices: PRICES });
  const { decision } = await guard.submit(base('two_escalations', { amount: '5' }));
  const codes = decision.reasons.map((r) => r.code);
  assert.equal(decision.verdict, 'require_approval');
  assert.ok(codes.includes('RISK_BUDGET_SHARE'), `expected RISK_BUDGET_SHARE in [${codes.join(', ')}]`);
  assert.ok(codes.includes('RISK_NEW_COUNTERPARTY'), `expected RISK_NEW_COUNTERPARTY in [${codes.join(', ')}]`);
  assert.equal(new Set(codes).size, codes.length, `duplicate codes: ${codes.join(', ')}`);
});

test('attack catalogue: every attempt hits the expected wall', async (t) => {
  for (const entry of CATALOGUE) {
    await t.test(`${entry.id} ${entry.name}`, async () => {
      const result = await runScenario(entry);
      assert.equal(result.verdict, entry.expect, `${entry.name}: expected ${entry.expect}, got ${result.verdict} [${result.codes.join(', ')}]`);
      for (const code of entry.expectCodes ?? []) {
        assert.ok(result.codes.includes(code), `${entry.name}: expected ${code} in [${result.codes.join(', ')}]`);
      }
    });
  }
});

test('draining the daily budget runs out of room exactly at the cap', async () => {
  const { guard, clock } = makeGuard();
  // Different vendors: four equal slices fill the 5 NEAR day without also
  // concentrating more than half of it on one address (that is drainage).
  const vendors = ['compute.near', 'storage.near', 'api.data-market.near', 'vendor.near'];
  for (let i = 0; i < 4; i++) {
    const { decision } = await guard.submit(base(`drain_${i}`, { asset: 'NEAR', amount: '1.25', to: vendors[i] }));
    assert.equal(decision.verdict, 'allow', `slice ${i} should fit: ${JSON.stringify(decision.reasons)}`);
    clock.t += 10_000;
  }
  const { decision } = await guard.submit(base('drain_5', { asset: 'NEAR', amount: '1.25', to: vendors[0] }));
  assert.equal(decision.verdict, 'deny');
  assert.ok(decision.reasons.some((r) => r.code === 'DAILY_LIMIT'));
});

test('the daily window really is a day, and the monthly window really is a month', async () => {
  const { guard, clock } = makeGuard();
  const vendors = ['compute.near', 'storage.near', 'api.data-market.near', 'vendor.near'];
  let allowed = 0;
  for (let day = 0; day < 20; day++) {
    for (let i = 0; i < 4; i++) {
      const { decision } = await guard.submit(base(`spread_${day}_${i}`, { asset: 'NEAR', amount: '1.25', to: vendors[i] }));
      if (decision.verdict === 'allow') allowed++;
      clock.t += 10_000;
    }
    clock.t += 86_400_000;
  }
  // 60 NEAR monthly cap / 1.25 NEAR slices = 48 allowed transactions in 20 days.
  assert.equal(allowed, 48);
});

test('a replayed action id cannot spend twice', async () => {
  const { guard, clock } = makeGuard();
  assert.equal((await guard.submit(base('same_id'))).decision.verdict, 'allow');
  clock.t += 10_000;
  const second = await guard.submit(base('same_id'));
  assert.equal(second.decision.verdict, 'deny');
  assert.ok(second.decision.reasons.some((r) => r.code === 'REPLAY'));
});

test('a burst trips the anomaly wall before the hourly cap', async () => {
  const { guard, clock } = makeGuard();
  let allowed = 0;
  for (let i = 0; i < 9; i++) {
    const { decision } = await guard.submit(base(`burst_${i}`, { asset: 'NEAR', amount: '0.1' }));
    if (decision.verdict === 'allow') allowed++;
    clock.t += 6_000;
  }
  assert.ok(allowed >= 4 && allowed <= 6, `expected 4-6 allowed transfers, got ${allowed}`);
  assert.ok(guard.getAnomalyFlags('argo.near').includes('BURST'));
});

test('pending approvals cannot book the same budget twice', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 5; i++) {
    const result = await guard.submit(base(`pend_${i}`, { amount: '20' }));
    assert.equal(result.decision.verdict, 'require_approval');
    assert.ok(result.approval);
    clock.t += 10_000;
  }
  const sixth = await guard.submit(base('pend_6', { amount: '20' }));
  assert.equal(sixth.decision.verdict, 'deny', 'five reservations of 20 USDC fill the 100 USDC day');
  assert.ok(sixth.decision.reasons.some((r) => r.code === 'DAILY_LIMIT'));
});

test('approval expires and releases the reservation', async () => {
  const { guard, clock } = makeGuard();
  const pending = await guard.submit(base('exp_1', { amount: '20' }));
  assert.ok(pending.approval);
  clock.t += 901_000; // ttl is 900s
  assert.equal((await guard.approve(pending.approval.id, 'alice.near')).status, 'expired');
  const after = await guard.submit(base('exp_2', { amount: '20' }));
  assert.equal(after.decision.verdict, 'require_approval', 'the reservation must be gone, so budget is back');
});

test('only a configured approver can release a payment', async () => {
  const { guard } = makeGuard();
  const pending = await guard.submit(base('who_1', { amount: '20' }));
  assert.ok(pending.approval);
  assert.equal((await guard.approve(pending.approval.id, 'random.near')).status, 'not_an_approver');
  assert.equal(
    (await guard.approve(pending.approval.id, 'argo.near')).status,
    'not_an_approver',
    'the agent must not be able to approve its own spending',
  );
});

test('an approval is re-checked against the current policy (TOCTOU)', async () => {
  const { guard } = makeGuard();
  const big = await guard.submit(base('toctou_big', { amount: '20' }));
  assert.ok(big.approval);
  guard.updatePolicy(
    policyText((doc) => {
      doc.risk = {};
      doc.velocity = {};
      if (doc.agents?.[0]) doc.agents[0].limits.perTx.USDC = 5;
      if (doc.limits.perTx) doc.limits.perTx.USDC = 5;
    }),
  );
  const result = await guard.approve(big.approval.id, 'alice.near');
  assert.equal(result.status, 'recheck_failed');
  assert.ok(result.decision?.reasons.some((r) => r.code === 'PER_TX_LIMIT'));
});

test('a human rejection frees the budget immediately', async () => {
  const { guard } = makeGuard();
  const pending = await guard.submit(base('rej_1', { amount: '90' }));
  // 90 is above the per-tx cap, so use an amount that escalates instead.
  assert.equal(pending.decision.verdict, 'deny');
  const approvable = await guard.submit(base('rej_1b', { amount: '20' }));
  assert.ok(approvable.approval);
  assert.equal(guard.reject(approvable.approval.id, 'alice.near', 'not this month').status, 'rejected');
  const next = await guard.submit(base('rej_2', { amount: '20' }));
  assert.equal(next.decision.verdict, 'require_approval', 'the rejected reservation must not consume budget');
});

test('the audit chain detects tampering', async () => {
  const { guard } = makeGuard();
  await guard.submit(base('audit_1'));
  await guard.submit(base('audit_2', { amount: '6' }));

  const state = guard.snapshot();
  const clean = AuditLog.fromJSON(state.audit);
  assert.equal(clean.verify().ok, true);

  const edited = structuredClone(state.audit);
  edited[0].amount = '0.01';
  const broken = AuditLog.fromJSON(edited).verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);

  const dropped = structuredClone(state.audit);
  dropped.splice(0, 1);
  assert.equal(AuditLog.fromJSON(dropped).verify().ok, false, 'dropping a record breaks the next link');

  // Honest limit: deleting the tail leaves a valid prefix chain. That is exactly
  // why the head hash has to be anchored where the agent cannot rewrite it - the
  // contract's decision hash chain (see contract/src/lib.rs).
  const tailDropped = structuredClone(state.audit);
  tailDropped.pop();
  const prefix = AuditLog.fromJSON(tailDropped).verify();
  assert.equal(prefix.ok, true);
  assert.notEqual(prefix.head, clean.verify().head);
});

test('a swapped-in policy is refused unless its hash matches the pin', () => {
  const generous = policyText((doc) => {
    if (doc.agents?.[0]) doc.agents[0].limits.perTx.USDC = 10_000;
    doc.limits.perTx = { ...doc.limits.perTx, USDC: 10_000 };
  });
  assert.throws(() => FeralGuard.create({ policyText: generous, expectedPolicyHash: 'a'.repeat(64) }), /hash mismatch/);
  const { guard } = makeGuard();
  assert.doesNotThrow(() => FeralGuard.create({ policyText: LAB, expectedPolicyHash: guard.policyHash }));
});

test('splitting below the approval line is bounded by the daily cap', async () => {
  const { guard, clock } = makeGuard(LAB, START);
  assert.equal((await guard.submit(base('split_1', { amount: '9.99' }))).decision.verdict, 'allow');
  clock.t += 10_000;
  assert.equal((await guard.submit(base('split_2', { amount: '9.99' }))).decision.verdict, 'allow');

  let denied = 0;
  for (let i = 0; i < 12; i++) {
    clock.t += 10_000;
    const { decision } = await guard.submit(base(`split_loop_${i}`, { amount: '9.99' }));
    if (decision.verdict === 'deny') denied++;
  }
  assert.ok(denied > 0, 'the daily budget eventually stops the loop');
});

test('an audit record is written for denials too, not only for spends', async () => {
  const { guard } = makeGuard();
  await guard.submit(base('denied_1', { amount: '26' }));
  const state = guard.snapshot();
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].verdict, 'deny');
  assert.ok(state.audit[0].reasons.includes('PER_TX_LIMIT'));
  assert.equal(guard.verifyAudit().ok, true);
});

test('a failing executor is recorded as a denial, not as an allow', async () => {
  const clock = { t: START };
  const guard = FeralGuard.create({
    policyText: LAB,
    clock: () => clock.t,
    prices: PRICES,
    executor: () => {
      throw new Error('relayer refused the transaction');
    },
  });
  const { decision, execution } = await guard.submit(base('exec_1'));
  assert.equal(decision.verdict, 'deny');
  assert.equal(execution?.status, 'failed');
  const state = guard.snapshot();
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].verdict, 'deny');
  assert.ok(state.audit[0].reasons.includes('EXECUTION_FAILED'));
  assert.equal(state.ledger.aggregate.length, 0, 'a failed execution must not book a spend');
});

test('the guard survives a save/load round trip', async () => {
  const dir = join(import.meta.dirname, '..', '..', 'data', 'tmp-state');
  const { guard } = makeGuard();
  await guard.submit(base('persist_1', { amount: '10' }));
  const file = guard.save(dir);
  assert.ok(file.endsWith('state.json'));

  const reloaded = FeralGuard.load(LAB, dir, { clock: () => START + 60_000, prices: PRICES });
  assert.equal(reloaded.policyHash, guard.policyHash);
  assert.equal(reloaded.auditLog.length, 1);
  assert.equal(reloaded.verifyAudit().ok, true);
});
