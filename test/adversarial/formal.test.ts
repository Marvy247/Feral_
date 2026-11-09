/**
 * Formal properties: statements that must hold for every input, checked by
 * enumeration rather than by a handful of examples.
 *
 * These complement the scenario catalogue (which proves specific walls exist)
 * and the property test (which throws random actions at the guard). Here the
 * claim is the shape of the decision function itself: a tighter policy can only
 * remove allows, replay is always refused, a paused policy denies every kind,
 * and every refusal carries a machine-readable reason.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ACTION_KINDS, compilePolicy, loadPolicy, type ActionKind } from '../../src/core/policy.ts';
import { SpendLedger } from '../../src/core/ledger.ts';
import { evaluate, type ActionRequest } from '../../src/core/engine.ts';
import { PRICES, START, policyText } from '../../src/demo/scenarios.ts';

const action = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'formal_1',
  kind: 'ft.transfer',
  actor: 'argo.near',
  asset: 'USDC',
  amount: '1',
  to: 'compute.near',
  ...overrides,
});

function compiled(mutate: Parameters<typeof policyText>[0]) {
  return compilePolicy(loadPolicy(policyText(mutate)).doc);
}

const quiet = (doc: Parameters<Parameters<typeof policyText>[0]>[0]): void => {
  doc.risk = {};
  doc.velocity = {};
  if (doc.approvals) doc.approvals.thresholdUsd = 10_000;
};

test('tightening the per-tx cap can only remove allows', () => {
  const loose = compiled((doc) => {
    quiet(doc);
    if (doc.agents?.[0]) doc.agents[0].limits.perTx.USDC = 100;
    doc.limits.perTx = { ...doc.limits.perTx, USDC: 100 };
  });
  const tight = compiled((doc) => {
    quiet(doc);
    if (doc.agents?.[0]) doc.agents[0].limits.perTx.USDC = 10;
    doc.limits.perTx = { ...doc.limits.perTx, USDC: 10 };
  });
  const now = START;
  for (let cents = 1; cents <= 12_000; cents += 250) {
    const amount = (cents / 100).toString();
    const ledger = new SpendLedger([], now);
    const a = evaluate(loose, action({ amount }), ledger, { now, prices: PRICES });
    const b = evaluate(tight, action({ amount }), ledger, { now, prices: PRICES });
    if (a.verdict === 'deny') {
      assert.notEqual(b.verdict, 'allow', `tightening turned ${amount} USDC from deny into allow`);
    }
    if (b.verdict === 'allow') assert.ok(cents <= 1_000, `${amount} USDC allowed above the 10 USDC cap`);
  }
});

test('a paused policy denies every action kind', () => {
  const paused = compiled((doc) => {
    quiet(doc);
    doc.paused = true;
  });
  const now = START;
  for (const kind of ACTION_KINDS as readonly ActionKind[]) {
    const decision = evaluate(paused, action({ kind, amount: '0.01', asset: 'NEAR' }), new SpendLedger([], now), { now, prices: PRICES });
    assert.equal(decision.verdict, 'deny', `${kind} was not denied by a paused policy`);
    assert.ok(decision.reasons.some((r) => r.code === 'POLICY_PAUSED'));
  }
});

test('every denial carries at least one deny-severity reason', () => {
  const tight = compiled((doc) => {
    quiet(doc);
    if (doc.agents?.[0]) doc.agents[0].limits.perTx.USDC = 1;
    doc.limits.perTx = { ...doc.limits.perTx, USDC: 1 };
  });
  const now = START;
  for (const kind of ACTION_KINDS as readonly ActionKind[]) {
    for (const amount of ['0', '2', '25', '1e5']) {
      const decision = evaluate(tight, action({ kind, amount }), new SpendLedger([], now), { now, prices: PRICES });
      if (decision.verdict !== 'deny') continue;
      assert.ok(decision.reasons.length > 0, `${kind} ${amount}: deny without a reason`);
      assert.ok(decision.reasons.some((r) => r.severity === 'deny'), `${kind} ${amount}: deny without a hard reason`);
    }
  }
});

test('a replayed action id is always refused, whatever the amount', () => {
  const now = START;
  const base = compiled(quiet);
  for (const amount of ['1', '5', '10', '25']) {
    const ledger = new SpendLedger([
      { actionId: 'formal_1', kind: 'ft.transfer', asset: 'USDC', amountMinor: '1000000', amount: '1', to: 'compute.near', at: now - 6_000, status: 'committed', verdict: 'allow' },
    ], now);
    const decision = evaluate(base, action({ amount }), ledger, { now, prices: PRICES });
    assert.equal(decision.verdict, 'deny');
    assert.deepEqual(decision.reasons.map((r) => r.code), ['REPLAY']);
  }
});

test('decision fingerprints are deterministic and context-bound', () => {
  const policy = compiled(quiet);
  const now = START;
  const first = evaluate(policy, action(), new SpendLedger([], now), { now, prices: PRICES });
  const again = evaluate(policy, action(), new SpendLedger([], now), { now, prices: PRICES });
  assert.equal(first.fingerprint, again.fingerprint);
  assert.equal(first.decisionId, again.decisionId);
  const other = evaluate(policy, action({ amount: '2' }), new SpendLedger([], now), { now, prices: PRICES });
  assert.notEqual(first.fingerprint, other.fingerprint);
});

test('the 20-check mirror reports every check, passed or not', () => {
  const policy = compiled(quiet);
  const now = START;
  const allowed = evaluate(policy, action(), new SpendLedger([], now), { now, prices: PRICES });
  const denied = evaluate(policy, action({ amount: '999' }), new SpendLedger([], now), { now, prices: PRICES });
  // Sixteen structural/limit checks always run; the agent-context checks
  // (attestation, aggregate, anomaly, breaker) are added when state is supplied.
  assert.ok(allowed.checks.length >= 16, `only ${allowed.checks.length} checks reported`);
  assert.equal(denied.checks.length, allowed.checks.length, 'a denial must not skip checks');
  assert.ok(denied.checks.some((check) => !check.passed));
});
