import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FeralGuard } from '../../src/core/service.ts';
import { GatedToolbox } from '../../src/integrations/toolbox.ts';
import { LAB, PRICES, START } from '../../src/demo/scenarios.ts';

function setup() {
  const clock = { t: START };
  const guard = FeralGuard.create({ policyText: LAB, clock: () => clock.t, prices: PRICES });
  let paid = 0;
  const toolbox = new GatedToolbox(guard).register({
    name: 'summarize',
    vendor: 'api.data-market.near',
    price: { asset: 'USDC', amount: '4' },
    handler: () => {
      paid++;
      return 'summary';
    },
  });
  return { guard, toolbox, clock, paidCount: () => paid };
}

test('a tool call inside the walls runs and books the spend', async () => {
  const { toolbox, paidCount } = setup();
  const outcome = await toolbox.call('summarize', { text: 'hello' }, 'call_1');
  assert.equal(outcome.status, 'ok');
  assert.equal(paidCount(), 1);
  if (outcome.status === 'ok') {
    assert.equal(outcome.result, 'summary');
    assert.equal(outcome.decision.verdict, 'allow');
  }
});

test('a tool that costs more than the per-tx cap never runs', async () => {
  const clock = { t: START };
  const guard = FeralGuard.create({ policyText: LAB, clock: () => clock.t, prices: PRICES });
  let paid = 0;
  const toolbox = new GatedToolbox(guard).register({
    name: 'expensive',
    vendor: 'api.data-market.near',
    price: { asset: 'USDC', amount: '40' },
    handler: () => {
      paid++;
      return 'never';
    },
  });
  const outcome = await toolbox.call('expensive', {}, 'call_2');
  assert.equal(outcome.status, 'refused');
  assert.equal(paid, 0, 'the handler must not run when the policy refuses');
  if (outcome.status === 'refused') assert.match(outcome.reason, /PER_TX_LIMIT/);
});

test('a tool paid to an unknown vendor is refused', async () => {
  const clock = { t: START };
  const guard = FeralGuard.create({ policyText: LAB, clock: () => clock.t, prices: PRICES });
  const toolbox = new GatedToolbox(guard).register({
    name: 'shady',
    vendor: 'random-api.near',
    price: { asset: 'USDC', amount: '2' },
    handler: () => 'data',
  });
  const outcome = await toolbox.call('shady', {}, 'call_3');
  assert.equal(outcome.status, 'refused');
  if (outcome.status === 'refused') assert.match(outcome.reason, /RECIPIENT_NOT_ALLOWED/);
});

test('a tool above the approval line is queued, not executed', async () => {
  const { toolbox, paidCount, guard } = setup();
  const expensive = new GatedToolbox(guard).register({
    name: 'report',
    vendor: 'api.data-market.near',
    price: { asset: 'USDC', amount: '20' },
    handler: () => 'report',
  });
  const outcome = await expensive.call('report', {}, 'call_4');
  assert.equal(outcome.status, 'pending_approval');
  assert.equal(paidCount(), 0);
  if (outcome.status === 'pending_approval') assert.match(outcome.approvalId, /^apr_/);
  assert.equal(toolbox.list().length, 1);
});

test('retrying the same call id cannot pay twice', async () => {
  const { toolbox, paidCount } = setup();
  const first = await toolbox.call('summarize', {}, 'same_call');
  assert.equal(first.status, 'ok');
  const second = await toolbox.call('summarize', {}, 'same_call');
  assert.equal(second.status, 'refused');
  if (second.status === 'refused') assert.match(second.reason, /REPLAY/);
  assert.equal(paidCount(), 1);
});
