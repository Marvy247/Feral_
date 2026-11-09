/**
 * Second on-chain scenario: the rolling daily window.
 *
 * Per-transaction limits are the easy wall; the daily one needs state. This script
 * spends exactly the remaining daily budget (accepted), then tries to exceed it by
 * 0.5 NEAR (must be reverted with DAILY_LIMIT), and reads the reason back from the
 * `deny` event on the failed receipt - so the claim is verified by the chain, not by
 * the script's own optimism.
 *
 * Continues from the accounts created by scripts/testnet-demo.ts. Re-runnable: it
 * computes the remaining budget from the contract before doing anything.
 *
 *   node scripts/testnet-daily-cap.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { hashObject } from '../src/core/canonical.ts';

const RPC = 'https://rpc.testnet.fastnear.com';
const GAS = 100_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;
const DAILY_LIMIT = 2n * ONE_NEAR;
const PER_TX_LIMIT = ONE_NEAR;
const root = join(import.meta.dirname, '..');
const dataDir = join(root, 'data');
const rolesPath = join(dataDir, 'testnet-roles.json');
const outPath = join(dataDir, 'testnet-daily.json');

interface KeyFile {
  accountId: string;
  secretKey: string;
}
interface Roles {
  owner: KeyFile;
  vendor: KeyFile;
  agent: KeyFile;
  agentKey: { publicKey: string; secretKey: string };
}
interface Attempt {
  ok: boolean;
  hash?: string;
  reason?: string;
  denyReason?: string | null;
  error?: string;
}

/** Exact NEAR rendering without floating point. */
function near(value: bigint): string {
  const whole = value / ONE_NEAR;
  const frac = ((value % ONE_NEAR) * 100n) / ONE_NEAR;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
}

if (!existsSync(rolesPath)) {
  console.error(`no accounts at ${rolesPath}. Run: node scripts/testnet-demo.ts`);
  process.exit(2);
}

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
const provider = new JsonRpcProvider({ url: RPC });
const agent = new Account(roles.agent.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.agentKey.secretKey)));
const owner = new Account(roles.owner.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)));
const view = (methodName: string, args: Record<string, unknown> = {}) =>
  owner.callFunction({ contractId: roles.owner.accountId, methodName, args });

/**
 * Pull the `feral/deny` reason out of a transaction result or a failed transaction.
 *
 * near-api-js raises a `ContractExecutionError` whose `txHash` is undefined; the
 * hash and the logs live in `error.transactionResult`.
 */
type ExecutionLike = {
  receipts_outcome?: { outcome: { logs: string[] } }[];
  transaction?: { hash?: string };
};

function denyReasonFrom(result: ExecutionLike | null | undefined): string | null {
  for (const receipt of result?.receipts_outcome ?? []) {
    for (const line of receipt.outcome.logs ?? []) {
      if (!line.startsWith('EVENT_JSON:')) continue;
      try {
        const event = JSON.parse(line.slice('EVENT_JSON:'.length)) as { event?: string; data?: { reason?: string } };
        if (event.event === 'deny' && event.data?.reason) return event.data.reason;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

async function denyReasonOf(txHash: string | undefined): Promise<string | null> {
  if (!txHash) return null;
  const status = (await provider
    .viewTransactionStatus({ txHash, accountId: roles.agent.accountId, waitUntil: 'EXECUTED_OPTIMISTIC' })
    .catch(() => null)) as ExecutionLike | null;
  return denyReasonFrom(status);
}

async function spend(amountYocto: bigint, label: string): Promise<Attempt> {
  try {
    const outcome = (await agent.signAndSendTransaction({
      receiverId: roles.owner.accountId,
      actions: [
        actions.functionCall(
          'spend',
          {
            asset_id: 'near',
            amount: amountYocto.toString(),
            to: roles.vendor.accountId,
            decision_hash: hashObject({ label, at: new Date().toISOString() }),
          },
          GAS,
          0n,
        ),
      ],
    })) as { transaction_outcome?: { id?: string } };
    const hash = outcome.transaction_outcome?.id;
    console.log(`  ${label}: ACCEPTED  ${hash}`);
    return { ok: true, hash };
  } catch (err) {
    const failure = err as { message?: string; txHash?: string; transactionResult?: ExecutionLike };
    const result = failure.transactionResult;
    const txHash = failure.txHash ?? result?.transaction?.hash;
    const message = (failure.message ?? 'rejected').replace(/\s+/g, ' ').slice(0, 160);
    const reason = denyReasonFrom(result) ?? (await denyReasonOf(txHash));
    console.log(`  ${label}: REJECTED  ${reason ?? message}`);
    if (txHash) console.log(`    ${' '.repeat(label.length)}  tx ${txHash}  https://testnet.nearblocks.io/txns/${txHash}`);
    return { ok: false, hash: txHash, error: message, denyReason: reason };
  }
}

const before = (await view('get_usage', { asset_id: 'near' })) as { day_spent: string };
const spentBefore = BigInt(before.day_spent);
const remaining = DAILY_LIMIT - spentBefore;
console.log(`day_spent: ${near(spentBefore)} NEAR, remaining today: ${near(remaining)} NEAR (per-tx cap ${near(PER_TX_LIMIT)} NEAR)`);

if (remaining <= 0n) {
  console.log('\nthe daily budget is already exhausted, so both steps below must be rejected');
} else {
  const fill = remaining < PER_TX_LIMIT ? remaining : PER_TX_LIMIT;
  console.log(`\n1. spend exactly the remaining room: ${near(fill)} NEAR (must be accepted)`);
  var first = await spend(fill, `spend(${near(fill)} NEAR)`);
}

console.log('\n2. try 0.50 NEAR more (fits per-tx, exceeds the daily budget)');
const second = await spend(ONE_NEAR / 2n, 'spend(0.50 NEAR)');

const after = (await view('get_usage', { asset_id: 'near' })) as { day_spent: string; month_spent: string };
const spentAfter = BigInt(after.day_spent);
const checkHalf = await view('check', { asset_id: 'near', amount: (ONE_NEAR / 2n).toString(), to: roles.vendor.accountId });

console.log(`\nday_spent after: ${near(spentAfter)} NEAR / 2.00 NEAR cap`);
console.log(`check(0.50 NEAR): ${JSON.stringify(checkHalf)}`);
console.log(`deny reason on the failed receipt: ${second.denyReason ?? '(not readable)'}`);

const filled = spentBefore === DAILY_LIMIT || spentAfter === DAILY_LIMIT || first?.ok === true;
const ok = !second.ok && second.denyReason === 'DAILY_LIMIT' && spentAfter <= DAILY_LIMIT && filled;
console.log(
  ok
    ? '\nverified on chain: the contract filled the day, then refused the next spend with DAILY_LIMIT'
    : '\nUNEXPECTED: the chain does not match the claim, see the output above',
);

mkdirSync(dataDir, { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      network: 'testnet',
      contract: roles.owner.accountId,
      vendor: roles.vendor.accountId,
      spentBefore: spentBefore.toString(),
      spentAfter: spentAfter.toString(),
      dailyLimit: DAILY_LIMIT.toString(),
      checkAfter: checkHalf,
      first: typeof first === 'undefined' ? null : first,
      second,
      at: new Date().toISOString(),
    },
    null,
    2,
  ),
  'utf8',
);
process.exitCode = ok ? 0 : 1;
