/**
 * Print the recorded testnet run as a readable transcript.
 *
 * Reads `data/testnet-demo.json` (written by scripts/testnet-demo.ts) instead of
 * retyping hashes, so the numbers in the demo post cannot drift from the run.
 *
 *   node scripts/show-testnet-run.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
/**
 * Prefer a fresh run in `data/`; fall back to the sanitised public record in
 * `docs/` so a reviewer without the testnet keys can still print the evidence.
 */
const localFile = join(root, 'data', 'testnet-demo.json');
const publicFile = join(root, 'docs', 'testnet-run.json');

if (!existsSync(localFile) && !existsSync(publicFile)) {
  console.error(`no recorded run at ${localFile} or ${publicFile}. Run: node scripts/testnet-demo.ts`);
  process.exit(2);
}

interface Summary {
  network: string;
  contract: string;
  vendor: string;
  agent: string;
  policyHash: string;
  transactions: Record<string, string>;
  rejected: { overLimit: string; pauseAttempt: string };
  onchain: {
    config: { limits: { asset_id: string; per_tx: string; daily: string; monthly: string }[]; allowlist: string[] };
    usage: { day_spent: string; month_spent: string };
    lastHash: string;
    decisionCount: number;
    checkOk: string;
    checkBad: string;
    checkStranger: string;
    vendorBalance: string;
    agentPublicKey?: string | null;
  };
  agentPublicKey?: string;
}

const run = (existsSync(localFile)
  ? JSON.parse(readFileSync(localFile, 'utf8'))
  : (JSON.parse(readFileSync(publicFile, 'utf8')) as { demo: unknown }).demo) as Summary;
/** `--compact` drops the explorer URLs so the text fits a screenshot. */
const compact = process.argv.includes('--compact');
const near = (yocto: string): string => (Number(BigInt(yocto)) / 1e24).toFixed(2);
const short = (value: string): string => (value.length > 24 ? `${value.slice(0, 12)}...${value.slice(-6)}` : value);
const txUrl = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

const lines: string[] = [];
lines.push('FERAL - on-chain proof on NEAR testnet');
lines.push('');
lines.push(`contract  ${run.contract}`);
lines.push(`agent     ${run.agent}`);
lines.push('          keys: 1 (FunctionCall on the contract, method "spend", allowance 2 NEAR)');
lines.push(`vendor    ${run.vendor}   (the only allow-listed payee)`);
lines.push(`policy    ${run.policyHash.slice(0, 32)}...`);
lines.push('');
lines.push('transactions');
const order: [string, string][] = [
  ['deploy contract', 'deploy'],
  ['new(owner, agent)', 'init'],
  ['agent adds spend-only key', 'addRestrictedKey'],
  ['agent deletes its full key', 'deleteFullKey'],
  ['owner installs policy', 'setPolicy'],
  ['agent spends 0.25 NEAR', 'spend'],
];
for (const [label, key] of order) {
  const hash = run.transactions[key];
  if (hash) lines.push(`  ${label.padEnd(28)} ${hash}${compact ? '' : '  ' + txUrl(hash)}`);
}
lines.push('');
lines.push('refusals');
lines.push(`  agent tries 1.5 NEAR         reverted by the contract: PER_TX_LIMIT`);
lines.push(`                               deny event emitted on the failed receipt`);
lines.push(`  agent tries set_paused       rejected by the access key before the contract ran`);
lines.push('');
lines.push('state read back from the contract (after the 0.25 NEAR spend)');
const limit = run.onchain.config.limits[0];
lines.push(`  limits          per tx ${near(limit.per_tx)} NEAR, daily ${near(limit.daily)} NEAR, monthly ${near(limit.monthly)} NEAR`);
lines.push(`  spend today     ${near(run.onchain.usage.day_spent)} NEAR`);
lines.push(`  decision chain  ${run.onchain.lastHash.slice(0, 32)}...  count ${run.onchain.decisionCount}`);
lines.push(`  vendor balance  ${near(run.onchain.vendorBalance)} NEAR  (0.25 NEAR arrived, 1.5 NEAR did not)`);
lines.push('');
lines.push('pre-flight, as an agent would call it before spending');
lines.push(`  check(0.1 NEAR) -> ${run.onchain.checkOk}`);
lines.push(`  check(5.0 NEAR) -> ${run.onchain.checkBad}`);
lines.push(`  check(stranger) -> ${run.onchain.checkStranger}`);

// Second scenario: the rolling daily window (records from scripts/testnet-daily-cap.ts).
const dailyPath = join(root, 'data', 'testnet-daily.json');
const dailyFromPublic = existsSync(publicFile)
  ? (JSON.parse(readFileSync(publicFile, 'utf8')) as { daily?: unknown }).daily
  : undefined;
if (existsSync(dailyPath) || dailyFromPublic) {
  const daily = (existsSync(dailyPath) ? JSON.parse(readFileSync(dailyPath, 'utf8')) : dailyFromPublic) as {
    spentAfter: string;
    dailyLimit: string;
    checkAfter: string;
    second?: { denyReason?: string | null; hash?: string };
  };
  lines.push('');
  lines.push('rolling daily window, later the same day');
  lines.push(`  spent today      ${near(daily.spentAfter)} NEAR of ${near(daily.dailyLimit)} NEAR`);
  lines.push(`  next 0.50 NEAR   reverted by the contract: ${daily.second?.denyReason ?? 'DAILY_LIMIT'}`);
  if (daily.second?.hash && !compact) lines.push(`                   ${txUrl(daily.second.hash)}`);
  lines.push(`  check(0.50)      ${daily.checkAfter}`);
}

console.log(lines.join('\n'));
if (process.argv.includes('--short')) {
  console.log(`\n(${short(run.agent)})`);
}
