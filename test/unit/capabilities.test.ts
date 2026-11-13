/**
 * The capability manifest must match the code it describes.
 *
 * `docs/CAPABILITIES.json` and `src/generated/capabilities.ts` are generated
 * from the engine, the Rust vault and the scenario catalogue. This test runs
 * the generator in `--check` mode, so a manifest that has drifted fails the
 * suite instead of quietly misleading a judge.
 *
 * It also asserts the two properties that make the manifest worth having:
 *
 *  - every check the Rust vault enforces has a mirror in the TypeScript engine
 *    (the one exception is declared: the vault's own balance check, which only
 *    the chain can know);
 *  - every scenario in the catalogue still produces its expected verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CAPABILITIES } from '../../src/generated/capabilities.ts';

const root = join(import.meta.dirname, '..', '..');

test('the capability manifest is in sync with the sources', () => {
  const result = spawnSync(process.execPath, ['scripts/gen-capabilities.ts', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `the manifest is out of date:\n${result.stdout}${result.stderr}\nrun: node scripts/gen-capabilities.ts`,
  );
});

test('docs/CAPABILITIES.json and the generated module agree', () => {
  const json = JSON.parse(readFileSync(join(root, 'docs', 'CAPABILITIES.json'), 'utf8'));
  assert.deepEqual(json.totals, CAPABILITIES.totals);
  assert.equal(json.checks.length, CAPABILITIES.checks.length);
  assert.equal(json.scenarios.length, CAPABILITIES.scenarios.length);
});

test('every check the Rust vault enforces has a mirror in the engine', () => {
  const unmirrored = CAPABILITIES.coverage.contractReasonCodesWithoutAMirror;
  assert.deepEqual(
    unmirrored,
    ['INSUFFICIENT_BALANCE'],
    'a contract reason code lost its engine mirror - either mirror it or update this expectation',
  );
});

test('every contract section is mirrored by at least one engine check', () => {
  for (const section of CAPABILITIES.coverage.contractSections) {
    assert.ok(
      section.mirroredBy.some((id) => id !== null),
      `contract section "${section.section}" has no mirror in the engine`,
    );
  }
});

test('every scenario in the manifest still passes', () => {
  for (const scenario of CAPABILITIES.scenarios) {
    assert.equal(scenario.passed, true, `scenario ${scenario.id} (${scenario.name}) no longer matches its expected verdict`);
  }
  assert.equal(CAPABILITIES.totals.scenariosFailing, 0);
});

test('the manifest states the numbers the README quotes', () => {
  // These are the claims the README makes. If the code changes, the README
  // must change with it, and this test is what notices.
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.ok(
    readme.includes(`${CAPABILITIES.totals.onChainChecks} checks enforced on-chain`),
    `the README must quote the manifest: ${CAPABILITIES.totals.onChainChecks} checks enforced on-chain`,
  );
  assert.ok(
    readme.includes(`${CAPABILITIES.totals.scenarios} adversarial scenarios`),
    `the README must quote the manifest: ${CAPABILITIES.totals.scenarios} adversarial scenarios`,
  );
});
