/**
 * Third on-chain scenario: a NEP-141 asset, not native NEAR.
 *
 * The contract supports non-native assets by treating `asset_id` as the token's
 * account id and calling `ft_transfer`. That path was never exercised on chain, so
 * this script proves it end to end with wNEAR: the vault holds wNEAR, the agent
 * spends wNEAR under a separate limit, and an over-limit wNEAR spend is refused with
 * the same reason machinery as NEAR.
 *
 *   node scripts/testnet-ft.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { hashObject } from '../src/core/canonical.ts';

const RPC = 'https://rpc.testnet.fastnear.com';
const TOKEN = 'wrap.testnet'; // wNEAR, 24 decimals
const DECIMALS = 24n;
const GAS = 100_000_000_000_000n;
const ONE = 10n ** DECIMALS;
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');
const outPath = join(root, 'data', 'testnet-ft.json');

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
type ExecutionLike = { receipts_outcome?: { outcome: { logs: string[] } }[]; transaction?: { hash?: string } };

const near = (value: bigint): string => {
  const whole = value / ONE;
  const frac = ((value % ONE) * 100n) / ONE;
  return `${whole}.${frac.toString().padStart(2, '0')}`;
};

if (!existsSync(rolesPath)) {
  console.error(`no accounts at ${rolesPath}. Run: node scripts/testnet-demo.ts`);
  process.exit(2);
}

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
const provider = new JsonRpcProvider({ url: RPC });
const owner = new Account(roles.owner.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)));
const agent = new Account(roles.agent.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.agentKey.secretKey)));
const contract = roles.owner.accountId;

const view = (methodName: string, args: Record<string, unknown> = {}) =>
  owner.callFunction({ contractId: contract, methodName, args });
const tokenView = (methodName: string, args: Record<string, unknown> = {}) =>
  owner.callFunction({ contractId: TOKEN, methodName, args });
const balanceOf = async (accountId: string): Promise<bigint> => BigInt(String(await tokenView('ft_balance_of', { account_id: accountId })));
const storageOf = async (accountId: string): Promise<unknown> => tokenView('storage_balance_of', { account_id: accountId });

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

async function call(
  account: Account,
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  depositYocto: bigint,
  label: string,
): Promise<string> {
  const outcome = (await account.signAndSendTransaction({
    receiverId,
    actions: [actions.functionCall(methodName, args, GAS, depositYocto)],
  })) as { transaction_outcome?: { id?: string } };
  const hash = outcome.transaction_outcome?.id ?? 'unknown';
  console.log(`  ${label.padEnd(46)} ${hash}`);
  return hash;
}

const txs: Record<string, string> = {};
const steps: string[] = [];

// 1. register both accounts with the token -----------------------------------
if ((await storageOf(contract)) === null) {
  txs.storageContract = await call(owner, TOKEN, 'storage_deposit', { account_id: contract }, 10_000_000_000_000_000_000_000n, 'storage_deposit(vault)');
}
if ((await storageOf(roles.vendor.accountId)) === null) {
  txs.storageVendor = await call(owner, TOKEN, 'storage_deposit', { account_id: roles.vendor.accountId }, 10_000_000_000_000_000_000_000n, 'storage_deposit(vendor)');
}

// 2. wrap NEAR into the vault ------------------------------------------------
// In this demo the vault *is* the owner account (the contract is deployed on it), so
// `near_deposit` credits the vault directly. A `ft_transfer` from the owner to
// itself would be rejected by the token ("Sender and receiver should be different"),
// which is worth knowing before writing an integration.
const vaultBalance = await balanceOf(contract);
if (vaultBalance < ONE) {
  const topUp = (3n * ONE) / 2n - vaultBalance; // reach 1.50 wNEAR in the vault
  txs.wrap = await call(owner, TOKEN, 'near_deposit', {}, topUp, `near_deposit(${near(topUp)} NEAR -> wNEAR in the vault)`);
}
steps.push(`vault holds ${near(await balanceOf(contract))} wNEAR`);

// 3. install a policy that covers both assets --------------------------------
const nearLimit = { asset_id: 'near', per_tx: ONE.toString(), daily: (2n * ONE).toString(), monthly: (10n * ONE).toString() };
const ftLimit = { asset_id: TOKEN, per_tx: (ONE / 2n).toString(), daily: ONE.toString(), monthly: (5n * ONE).toString() };
// The hash pins exactly what is installed, so the audit trail can commit to it.
const installedHash = hashObject({ limits: [nearLimit, ftLimit], allowlist: [roles.vendor.accountId] });
txs.setPolicy = await call(
  owner,
  contract,
  'set_policy',
  { policy_hash: installedHash, limits: [nearLimit, ftLimit], allowlist: [roles.vendor.accountId] },
  0n,
  'set_policy(near + wrap.testnet)',
);
steps.push(`check(0.60 wNEAR) -> ${JSON.stringify(await view('check', { asset_id: TOKEN, amount: ((ONE * 6n) / 10n).toString(), to: roles.vendor.accountId }))}`);
steps.push(`check(0.40 wNEAR) -> ${JSON.stringify(await view('check', { asset_id: TOKEN, amount: ((ONE * 4n) / 10n).toString(), to: roles.vendor.accountId }))}`);

// 4. the agent spends wNEAR inside the limit --------------------------------
const before = await balanceOf(roles.vendor.accountId);
txs.spend = await call(agent, contract, 'spend', { asset_id: TOKEN, amount: ((ONE * 4n) / 10n).toString(), to: roles.vendor.accountId, decision_hash: 'e'.repeat(64) }, 0n, 'spend(0.40 wNEAR) -> vendor');
const after = await balanceOf(roles.vendor.accountId);
steps.push(`vendor wNEAR ${near(before)} -> ${near(after)} (delta ${near(after - before)})`);

// 5. and is refused above the per-transaction cap ---------------------------
let refusedReason: string | null = null;
let refusedTx: string | undefined;
try {
  await agent.signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall('spend', { asset_id: TOKEN, amount: ((ONE * 6n) / 10n).toString(), to: roles.vendor.accountId, decision_hash: 'f'.repeat(64) }, GAS, 0n)],
  });
  steps.push('spend(0.60 wNEAR): UNEXPECTEDLY ACCEPTED');
} catch (err) {
  const failure = err as { message?: string; txHash?: string; transactionResult?: ExecutionLike };
  refusedTx = failure.txHash ?? failure.transactionResult?.transaction?.hash;
  refusedReason = denyReasonFrom(failure.transactionResult);
  steps.push(`spend(0.60 wNEAR) refused: ${refusedReason ?? failure.message?.slice(0, 60)}`);
  if (refusedTx) steps.push(`  tx ${refusedTx}  https://testnet.nearblocks.io/txns/${refusedTx}`);
}

const usage = (await view('get_usage', { asset_id: TOKEN })) as { day_spent: string; month_spent: string };
steps.push(`get_usage(wrap.testnet): day ${near(BigInt(usage.day_spent))}, month ${near(BigInt(usage.month_spent))}`);

const ok = after - before === (ONE * 4n) / 10n && refusedReason === 'PER_TX_LIMIT' && BigInt(usage.day_spent) === (ONE * 4n) / 10n;
console.log('\n' + steps.join('\n'));
console.log(ok ? '\nverified on chain: wNEAR moved through the vault, and the wNEAR cap refused the next one' : '\nUNEXPECTED: see the steps above');

mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({ network: 'testnet', token: TOKEN, contract, vendor: roles.vendor.accountId, at: new Date().toISOString(), txs, steps, ok, refusedReason, refusedTx }, null, 2),
  'utf8',
);
process.exitCode = ok ? 0 : 1;
