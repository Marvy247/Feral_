/**
 * The browser demo must be the real engine, and it must not drift.
 *
 * Two assertions:
 *
 *  1. The committed bundle produces the same 52 verdicts as the engine does
 *     natively. The bundle is executed in a `node:vm` sandbox - the same code
 *     path a browser tab takes - and every scenario's verdict is compared with
 *     the catalogue's expected verdict.
 *  2. The committed artefacts are what `scripts/build-demo.ts` produces from the
 *     current sources. A rebuild must be byte-identical, so the demo page can
 *     never quietly fall behind the code it claims to run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { CATALOGUE, runScenario } from '../../src/demo/scenarios.ts';

const root = join(import.meta.dirname, '..', '..');
const bundlePath = join(root, 'docs', 'demo', 'feral-demo.js');
const htmlPath = join(root, 'docs', 'demo', 'index.html');

interface DemoScenario {
  id: number;
  expect: string;
  verdict: string;
  passed: boolean;
  codes: string[];
}

interface DemoPayload {
  scenarios: DemoScenario[];
  totals: { count: number; denied: number; escalated: number; allowed: number; failed: number };
  capability: { offChainReasonCodes: number; onChainReasonCodes: string[] };
}

interface DemoModule {
  default: Promise<DemoPayload>;
  createLiveSession: () => { state(): { reputation: number; auditOk: boolean } };
}

function loadBundle(): DemoModule {
  const code = readFileSync(bundlePath, 'utf8');
  const context = vm.createContext({
    console,
    TextEncoder,
    TextDecoder,
    structuredClone,
    Date,
    Math,
    JSON,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(code, context, { filename: 'feral-demo.js' });
  return (context as unknown as { FERAL_DEMO: DemoModule }).FERAL_DEMO;
}

test('the browser bundle exists and is committed', () => {
  assert.ok(existsSync(bundlePath), 'docs/demo/feral-demo.js is missing - run node scripts/build-demo.ts');
  assert.ok(existsSync(htmlPath), 'docs/demo/index.html is missing - run node scripts/build-demo.ts');
});

test('the browser bundle reproduces every verdict of the catalogue', async () => {
  const demo = loadBundle();
  const payload = await demo.default;

  assert.equal(payload.scenarios.length, CATALOGUE.length, 'the demo runs a different number of scenarios');

  for (const scenario of payload.scenarios) {
    const expected = CATALOGUE.find((entry) => entry.id === scenario.id);
    assert.ok(expected, `scenario ${scenario.id} is not in the catalogue`);
    assert.equal(
      scenario.verdict,
      expected.expect,
      `scenario ${scenario.id} (${expected.name}) decided ${scenario.verdict} in the browser, expected ${expected.expect}`,
    );
    for (const code of expected.expectCodes ?? []) {
      assert.ok(
        scenario.codes.includes(code),
        `scenario ${scenario.id} (${expected.name}) did not raise ${code} in the browser: ${scenario.codes.join(', ')}`,
      );
    }
  }

  assert.equal(payload.totals.failed, 0, 'the browser bundle disagrees with the catalogue somewhere');
});

test('the browser bundle and the native engine agree scenario by scenario', async () => {
  const demo = loadBundle();
  const payload = await demo.default;
  for (const entry of CATALOGUE) {
    const native = await runScenario(entry);
    const inBrowser = payload.scenarios.find((scenario) => scenario.id === entry.id);
    assert.ok(inBrowser, `scenario ${entry.id} missing from the browser payload`);
    assert.equal(
      inBrowser.verdict,
      native.verdict,
      `scenario ${entry.id} (${entry.name}): browser ${inBrowser.verdict} vs engine ${native.verdict}`,
    );
    assert.deepEqual(
      [...inBrowser.codes].sort(),
      [...native.codes].sort(),
      `scenario ${entry.id} (${entry.name}) raised different reason codes`,
    );
  }
});

test('the live session in the browser moves state like the real guard', async () => {
  const demo = loadBundle();
  const session = demo.createLiveSession();
  const before = session.state();
  assert.equal(before.reputation, 100);
  assert.equal(before.auditOk, true);

  await session.submit({ label: 'overspend', amount: '26', to: 'compute.near' });
  const after = session.state();
  assert.equal(after.verdict, 'deny');
  assert.ok(after.reputation < before.reputation, 'a denial must cost the agent reputation');
  assert.equal(after.auditOk, true, 'the audit chain must still verify');
});
