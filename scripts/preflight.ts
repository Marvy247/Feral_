/**
 * Pre-flight: one command that answers "is this repository shippable right now?".
 *
 * Static checks read the repository; dynamic checks run the suites and the demo
 * commands and look only at their exit codes, so a green line means the command
 * really exited 0.
 *
 *   node scripts/preflight.ts
 *   node scripts/preflight.ts --offline   # skip the network checks
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, compilePolicy } from '../src/core/policy.ts';
import { CATALOGUE } from '../src/demo/scenarios.ts';

const root = join(import.meta.dirname, '..');
const offline = process.argv.includes('--offline');

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Row { name: string; status: Status; detail: string }
const rows: Row[] = [];
const add = (name: string, ok: boolean | null, detail: string): void => {
  rows.push({ name, status: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail });
};

const read = (path: string): string => readFileSync(join(root, path), 'utf8');

function run(name: string, command: string, args: string[], timeoutMs = 240_000): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'ignore', timeout: timeoutMs });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    add(name, false, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    return;
  }
  add(name, result.status === 0, result.status === 0 ? 'exit 0' : `exit ${result.status ?? 'null (killed)'}`);
}

// ---------------------------------------------------------------- static ----
const { doc } = loadPolicy(read('examples/policy.yaml'));
const compiled = compilePolicy(doc);
add('policy compiles', true, `${doc.name}, v${doc.version}, hash ${compiled.hash.slice(0, 12)}, ${compiled.agents.length} agents`);

add(
  'scenario catalogue is consistent',
  CATALOGUE.length >= 50 && CATALOGUE.every((scenario) => ['allow', 'deny', 'require_approval', 'cancelled', 'frozen', 'thawed'].includes(scenario.expect)),
  `${CATALOGUE.length} scenarios, every one with an expected verdict`,
);

const wasm = join(root, 'contract', 'res', 'feral_vault.wasm');
if (existsSync(wasm)) {
  const bytes = statSync(wasm).size;
  const sha = createHash('sha256').update(readFileSync(wasm)).digest('hex');
  add('built contract exists', true, `${bytes.toLocaleString('en-US')} bytes, sha ${sha.slice(0, 12)}`);
} else {
  add('built contract exists', false, 'contract/res/feral_vault.wasm is missing; run contract/build.sh');
}

const documents = [
  'README.md',
  'SECURITY.md',
  'AGENTS.md',
  'THREAT_MODEL.md',
  'docs/FAQ.md',
  'docs/DEMO.md',
  'docs/TESTNET.md',
  'contract/README.md',
  'src/app/README.md',
];
const broken: string[] = [];
const fenceProblems: string[] = [];
const exactCase = (path: string): boolean => {
  try {
    const wanted = path.split(/[\\/]/).pop() ?? '';
    return readdirSync(dirname(path)).includes(wanted);
  } catch {
    return false;
  }
};
for (const file of documents) {
  if (!existsSync(join(root, file))) {
    broken.push(`${file} (missing)`);
    continue;
  }
  const text = read(file);
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) fenceProblems.push(`${file} (${fences} fences)`);
  for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('mailto:')) continue;
    const resolved = join(root, dirname(file), target);
    const fallback = join(root, target);
    const found = (existsSync(resolved) && exactCase(resolved)) || (existsSync(fallback) && exactCase(fallback));
    if (!found) broken.push(`${file} -> ${target}`);
  }
}
add('markdown links resolve (exact case)', broken.length === 0, broken.length === 0 ? `${documents.length} documents` : `broken: ${broken.slice(0, 3).join(', ')}`);
add('code fences are balanced', fenceProblems.length === 0, fenceProblems.length === 0 ? 'every ``` pair closes' : fenceProblems.join(', '));
add('secrets are gitignored', read('.gitignore').includes('data/*.json'), 'data/*.json ignored, fixtures excepted');
add('the README names the real catalogue size', /50\+ adversarial|52 adversarial/.test(read('README.md')), `${CATALOGUE.length} scenarios in the catalogue`);

// --------------------------------------------------------------- dynamic ----
run('test suite', process.execPath, ['--test-isolation=none', '--test', 'test/**/*.test.ts']);
run('attack catalogue', process.execPath, ['src/cli/feral.ts', 'attack']);
run('judge mode', process.execPath, ['src/cli/feral.ts', 'demo:judge']);
run('deterministic verify', process.execPath, ['src/cli/feral.ts', 'verify']);
run('narrative demo', process.execPath, ['src/cli/feral.ts', 'demo']);
run('mvp demo', process.execPath, ['src/cli/mvp.ts']);
run('use-case story', process.execPath, ['src/cli/story.ts']);
run('agent loop', process.execPath, ['src/cli/agent.ts']);
run('docs audit (commands and paths)', process.execPath, ['scripts/audit-docs.ts']);

if (offline) {
  add('chain signatures', null, 'skipped (--offline)');
  add('live 1Click quote', null, 'skipped (--offline)');
} else {
  run('chain signatures', process.execPath, ['src/cli/feral.ts', 'chainsig'], 120_000);
  run('live 1Click quote', process.execPath, ['src/cli/feral.ts', 'quote'], 120_000);
}

// ---------------------------------------------------------------- report ----
const width = Math.max(...rows.map((row) => row.name.length));
console.log('');
console.log(`preflight${offline ? ' (offline)' : ''}`);
console.log('-'.repeat(width + 44));
for (const row of rows) console.log(`${row.name.padEnd(width)}  ${row.status.padEnd(5)}  ${row.detail}`);
const failed = rows.filter((row) => row.status === 'FAIL');
const skipped = rows.filter((row) => row.status === 'SKIP').length;
console.log('-'.repeat(width + 44));
console.log(`${rows.length - failed.length - skipped} passed, ${failed.length} failed, ${skipped} skipped`);
console.log(failed.length === 0 ? 'shippable: the repository is consistent and every command exited 0.' : 'not shippable yet: fix the FAIL lines above.');
process.exitCode = failed.length === 0 ? 0 : 1;
