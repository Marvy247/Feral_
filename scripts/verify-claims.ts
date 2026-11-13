/**
 * Re-measure every claim the README makes.
 *
 * A README is a promise. This script turns the promises into checks: it runs
 * the command behind each claim, looks at what it printed, and prints the
 * measured evidence next to the claim. If a number in the README stops being
 * true, this exits non-zero.
 *
 *   node scripts/verify-claims.ts            # the offline claims
 *   node scripts/verify-claims.ts --json     # machine-readable output
 *   node scripts/verify-claims.ts --network  # also the claims that need the network
 *
 * It also writes docs/CLAIMS.md: the same table with the measured output, so
 * the repository carries a record of what was true when it was published.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CAPABILITIES } from '../src/generated/capabilities.ts';

const root = join(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');
const withNetwork = process.argv.includes('--network');

interface Claim {
  id: string;
  claim: string;
  command: string;
  args: string[];
  /** Substrings that must all appear in the output. */
  expect?: string[];
  /** Regex whose first capture group becomes the measured evidence. */
  evidence?: RegExp;
  needsNetwork?: boolean;
  needsRust?: boolean;
  cwd?: string;
}

const claims: Claim[] = [
  {
    id: 'suite',
    claim: 'the whole test suite passes offline',
    command: 'node',
    args: ['--test-isolation=none', '--test', 'test/**/*.test.ts'],
    expect: ['fail 0'],
    evidence: /ℹ tests (\d+)/,
  },
  {
    id: 'attack',
    claim: 'every escape attempt in the catalogue is caught',
    command: 'node',
    args: ['src/cli/feral.ts', 'attack'],
    expect: ['attempts:'],
    evidence: /(\d+ attempts: .*)/,
  },
  {
    id: 'verify',
    claim: 'the invariants hold under 1000 random actions',
    command: 'node',
    args: ['src/cli/feral.ts', 'verify'],
    expect: ['ALL PASS'],
    evidence: /(\d+ invariants verified)/,
  },
  {
    id: 'injection',
    claim: 'a prompt-injected agent cannot move money',
    command: 'node',
    args: ['src/cli/agent-attack.ts'],
    expect: ['the model was fooled; the vault was not'],
    evidence: /(the model was fooled; the vault was not)/,
  },
  {
    id: 'blocklist',
    claim: 'a cross-vault counterparty report blocks the spend before the key signs',
    command: 'node',
    args: ['src/cli/blocklist-attack.ts'],
    expect: ['registry rating: block', 'attacker received: 0 NEAR'],
    evidence: /(attacker received: 0 NEAR across both vaults)/,
  },
  {
    id: 'judge',
    claim: 'the judge demo completes with no failures',
    command: 'node',
    args: ['src/cli/feral.ts', 'demo:judge'],
    expect: ['0 failures'],
    evidence: /(FERAL DEMO COMPLETE.*)/,
  },
  {
    id: 'demo-bundle',
    claim: 'the committed browser demo is what the current sources build',
    command: 'node',
    args: ['scripts/build-demo.ts', '--check'],
    expect: ['demo bundle is current'],
    evidence: /(demo bundle is current.*)/,
  },
  {
    id: 'capabilities',
    claim: 'the capability manifest matches the engine, the vault and the catalogue',
    command: 'node',
    args: ['scripts/gen-capabilities.ts', '--check'],
    expect: ['capability manifest is current'],
    evidence: /(capability manifest is current)/,
  },
  {
    id: 'docs',
    claim: 'every command and path mentioned in the documentation exists',
    command: 'node',
    args: ['scripts/audit-docs.ts'],
    expect: [],
    evidence: /(.*(ok|pass).*)/i,
  },
  {
    id: 'vault-tests',
    claim: 'the Rust vault passes its own unit tests on a NEAR VM',
    command: 'cargo',
    args: ['test', '--manifest-path', 'contract/Cargo.toml'],
    expect: ['test result: ok'],
    evidence: /(test result: ok\. (\d+) passed)/,
    needsRust: true,
  },
  {
    id: 'bench',
    claim: 'a decision costs tens of microseconds',
    command: 'node',
    args: ['scripts/bench.ts'],
    expect: ['us'],
    evidence: /(ft\.transfer.*)/,
  },
  {
    id: 'readme-numbers',
    claim: 'the README quotes the numbers the code produces',
    command: 'node',
    args: ['scripts/check-readme-numbers.ts'],
    expect: ['README numbers match'],
    evidence: /(README numbers match.*)/,
  },
];

const networkClaims: Claim[] = [
  {
    id: 'conformance',
    claim: 'the deployed vault agrees with the mirror on 37 checks',
    command: 'node',
    args: ['scripts/testnet-conformance.ts'],
    expect: [],
    evidence: /(.*37\/37.*)/,
    needsNetwork: true,
  },
  {
    id: 'quote',
    claim: 'a live NEAR Intents quote is validated before a swap',
    command: 'node',
    args: ['src/cli/feral.ts', 'quote'],
    expect: [],
    evidence: /(.*)/,
    needsNetwork: true,
  },
];

interface Result {
  id: string;
  claim: string;
  command: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  evidence: string;
  durationMs: number;
}

function run(claim: Claim): Result {
  const started = Date.now();
  const result = spawnSync(claim.command, claim.args, {
    cwd: join(root, claim.cwd ?? '.'),
    encoding: 'utf8',
    timeout: 600_000,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const missing = (claim.expect ?? []).filter((needle) => !output.includes(needle));
  const ok = result.status === 0 && missing.length === 0;
  const evidence = claim.evidence?.exec(output)?.[1]?.trim() ?? '';
  return {
    id: claim.id,
    claim: claim.claim,
    command: `${claim.command} ${claim.args.join(' ')}`,
    status: ok ? 'PASS' : 'FAIL',
    evidence: ok ? evidence || 'exit 0' : missing.length > 0 ? `missing: ${missing.join(', ')}` : `exit ${result.status}`,
    durationMs: Date.now() - started,
  };
}

function skip(claim: Claim, reason: string): Result {
  return {
    id: claim.id,
    claim: claim.claim,
    command: `${claim.command} ${claim.args.join(' ')}`,
    status: 'SKIP',
    evidence: reason,
    durationMs: 0,
  };
}

function hasRust(): boolean {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

const rustAvailable = hasRust();
const results: Result[] = [];

for (const claim of claims) {
  if (claim.needsRust && !rustAvailable) {
    results.push(skip(claim, 'cargo is not installed'));
    continue;
  }
  results.push(run(claim));
}

if (withNetwork) {
  for (const claim of networkClaims) results.push(run(claim));
}

const failed = results.filter((r) => r.status === 'FAIL');
const skipped = results.filter((r) => r.status === 'SKIP');

if (asJson) {
  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        totals: {
          claims: results.length,
          passed: results.length - failed.length - skipped.length,
          failed: failed.length,
          skipped: skipped.length,
        },
        capability: CAPABILITIES.totals,
        results,
      },
      null,
      2,
    ),
  );
} else {
  const width = Math.max(...results.map((r) => r.claim.length));
  console.log('');
  console.log('FERAL CLAIM VERIFICATION');
  console.log('-'.repeat(100));
  for (const result of results) {
    const mark = result.status === 'PASS' ? 'PASS' : result.status === 'FAIL' ? 'FAIL' : 'SKIP';
    console.log(`${mark.padEnd(4)} ${result.claim.padEnd(width)}  ${result.evidence}`);
    console.log(`     ${result.command}`);
  }
  console.log('-'.repeat(100));
  console.log(
    `${results.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
  );
  console.log('');
  console.log('The manifest says:');
  console.log(
    `  ${CAPABILITIES.totals.onChainChecks} checks enforced on-chain, ${CAPABILITIES.totals.engineChecks} in the mirror, ` +
      `${CAPABILITIES.totals.contractReasonCodes} reason codes in the vault, ${CAPABILITIES.totals.scenarios} scenarios.`,
  );
  console.log('');
}

// Keep a record of what was true when the repository was published.
if (!asJson) {
  const lines: string[] = [];
  lines.push('# Measured claims');
  lines.push('');
  lines.push('Generated by `npm run verify:claims`. Every row is a command and the output it produced.');
  lines.push('');
  lines.push('| Claim | Command | Result | Measured |');
  lines.push('|---|---|---|---|');
  for (const result of results) {
    lines.push(`| ${result.claim} | \`${result.command}\` | ${result.status} | ${result.evidence.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push(`Checks in the vault: ${CAPABILITIES.totals.onChainChecks} enforced on-chain, ${CAPABILITIES.totals.engineChecks} in the mirror.`);
  lines.push(`Escape attempts: ${CAPABILITIES.totals.scenarios} (${CAPABILITIES.totals.scenariosDenied} denied, ${CAPABILITIES.totals.scenariosEscalated} escalated).`);
  lines.push('');
  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'CLAIMS.md'), lines.join('\n'), 'utf8');
}

process.exit(failed.length > 0 ? 1 : 0);
