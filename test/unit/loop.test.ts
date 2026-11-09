import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FeralGuard } from '../../src/core/service.ts';
import { GatedToolbox } from '../../src/integrations/toolbox.ts';
import { formatTrace, nextStepAfterRefusal, runTask, type PlanStep } from '../../src/integrations/loop.ts';
import { LAB, PRICES, START } from '../../src/demo/scenarios.ts';

function setup() {
  const clock = { t: START };
  const guard = FeralGuard.create({ policyText: LAB, clock: () => clock.t, prices: PRICES });
  const ran: string[] = [];
  const toolbox = new GatedToolbox(guard)
    .register({
      name: 'expensive',
      vendor: 'api.data-market.near',
      price: { asset: 'USDC', amount: '40' },
      handler: () => {
        ran.push('expensive');
        return 'big';
      },
    })
    .register({
      name: 'cheap',
      vendor: 'api.data-market.near',
      price: { asset: 'USDC', amount: '4' },
      handler: () => {
        ran.push('cheap');
        return 'small';
      },
    })
    .register({
      name: 'scam',
      vendor: 'drainer.near',
      price: { asset: 'USDC', amount: '1' },
      handler: () => {
        ran.push('scam');
        return 'stolen';
      },
    });
  return { guard, toolbox, clock, ran };
}

const plan: PlanStep[] = [
  { tool: 'expensive', why: 'what the task asks for' },
  { tool: 'cheap', why: 'a smaller tier from the same vendor' },
];

test('the agent adapts to a refusal and finishes with a legal step', async () => {
  const { toolbox, ran } = setup();
  const report = await runTask(toolbox, 'summarize everything', plan);
  assert.equal(report.status, 'done');
  assert.equal(report.attempts.length, 2);
  assert.equal(report.attempts[0].outcome, 'refused');
  assert.ok(report.attempts[0].codes.includes('PER_TX_LIMIT'));
  assert.equal(report.attempts[1].outcome, 'ok');
  // The expensive handler must never run: the policy refused it before the handler.
  assert.deepEqual(ran, ['cheap']);
});

test('a denied recipient is a hard stop, not a price problem', async () => {
  const { toolbox, ran } = setup();
  const report = await runTask(toolbox, 'buy something', [{ tool: 'scam', why: 'cheap rows' }]);
  assert.equal(report.status, 'gave_up');
  assert.equal(report.attempts.length, 1);
  assert.ok(report.attempts[0].codes.includes('RECIPIENT_DENIED'));
  assert.deepEqual(ran, []);
});

test('the hard-stop list stops a plan even when a cheaper step exists', () => {
  const steps: PlanStep[] = [
    { tool: 'expensive', why: 'first' },
    { tool: 'cheap', why: 'second' },
  ];
  assert.equal(nextStepAfterRefusal(['PER_TX_LIMIT'], steps, 0)?.tool, 'cheap');
  assert.equal(nextStepAfterRefusal(['RECIPIENT_DENIED'], steps, 0), null);
  assert.equal(nextStepAfterRefusal(['POLICY_PAUSED'], steps, 0), null);
  assert.equal(nextStepAfterRefusal(['PER_TX_LIMIT'], steps, 1), null, 'no step past the end of the plan');
});

test('the loop is bounded: it never attempts more than the plan', async () => {
  const { toolbox } = setup();
  const report = await runTask(toolbox, 'impossible', plan, { maxAttempts: 1 });
  assert.ok(report.attempts.length <= 1);
  assert.equal(report.status, 'gave_up');
});

test('the trace names the reason for every attempt', async () => {
  const { toolbox } = setup();
  const report = await runTask(toolbox, 'summarize everything', plan);
  const trace = formatTrace(report);
  assert.match(trace, /PER_TX_LIMIT/);
  assert.match(trace, /result: done/);
  assert.match(trace, /why this step/);
});
