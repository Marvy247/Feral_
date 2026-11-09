/**
 * Rotate the agent account.
 *
 * A function-call key has a finite allowance, and gas is charged against it, so the
 * agent eventually runs out of room even if it never overspends. The fix is the same
 * one you would use after a key leak: mint a fresh agent account, give it a
 * spend-only key, and point the contract at it with `set_agent`.
 *
 * This script does exactly that and prints every step, so the owner's recovery path
 * is exercised rather than described.
 *
 *   node scripts/testnet-rotate-agent.ts [allowanceNear]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';

const RPC = 'https://rpc.testnet.fastnear.com';
const FAUCET = 'https://faucet-near-testnet.onrender.com/api/faucet';
const GAS = 100_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');

interface KeyFile {
  accountId: string;
  publicKey: string;
  secretKey: string;
}
interface Roles {
  owner: KeyFile;
  vendor: KeyFile;
  agent: KeyFile;
  agentKey: { publicKey: string; secretKey: string };
  rotations?: { accountId: string; at: string; reason: string }[];
}

const allowance = BigInt(Math.round(Number(process.argv[2] ?? '10') * 1e6)) * 10n ** 18n;

if (!existsSync(rolesPath)) {
  console.error(`no accounts at ${rolesPath}. Run: node scripts/testnet-demo.ts`);
  process.exit(2);
}
const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
const provider = new JsonRpcProvider({ url: RPC });
const owner = new Account(roles.owner.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)));
const balanceOf = async (accountId: string): Promise<bigint> => {
  const view = await provider.viewAccount({ accountId }).catch(() => null);
  return view ? BigInt((view as { amount?: string }).amount ?? '0') : 0n;
};

// 1. a fresh implicit account, funded by the faucet --------------------------
const keyPair = KeyPair.fromRandom('ed25519');
const newAccountId = Buffer.from(keyPair.getPublicKey().data).toString('hex');
const newAccount: KeyFile = {
  accountId: newAccountId,
  publicKey: keyPair.getPublicKey().toString(),
  secretKey: keyPair.toString(),
};
console.log(`1. new agent account ${newAccountId}`);

const faucetResponse = await fetch(FAUCET, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ accountId: newAccountId }),
});
console.log(`   faucet ${faucetResponse.status} ${(await faucetResponse.text()).slice(0, 80)}`);
for (let attempt = 0; attempt < 12 && (await balanceOf(newAccountId)) === 0n; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 2_500));
}
const funded = await balanceOf(newAccountId);
if (funded === 0n) throw new Error('the faucet did not fund the new agent account');
console.log(`   funded with ${Number(funded) / 1e24} NEAR`);

// 2. the agent keeps only a spend-only key ----------------------------------
const signer = new Account(newAccountId, provider, new KeyPairSigner(keyPair));
const restricted = KeyPair.fromRandom('ed25519');
const addKeyTx = (await signer.signAndSendTransaction({
  receiverId: newAccountId,
  actions: [actions.addFunctionCallAccessKey(restricted.getPublicKey(), roles.owner.accountId, ['spend'], allowance)],
})) as { transaction_outcome?: { id?: string } };
console.log(`2. addKey(spend only, allowance ${Number(allowance) / 1e24} NEAR)  ${addKeyTx.transaction_outcome?.id}`);

const deleteKeyTx = (await signer.signAndSendTransaction({
  receiverId: newAccountId,
  actions: [actions.deleteKey(keyPair.getPublicKey())],
})) as { transaction_outcome?: { id?: string } };
console.log(`3. deleteKey(full access)                            ${deleteKeyTx.transaction_outcome?.id}`);

// The RPC can serve a slightly stale access-key list right after the delete, so poll
// until the account really has only the scoped key before reporting success.
type KeyList = { keys?: { access_key: { permission: unknown } }[] };
const permissionsOf = async (): Promise<string> => {
  const list = (await provider.viewAccessKeyList({ accountId: newAccountId })) as KeyList;
  return JSON.stringify(list.keys?.map((k) => (typeof k.access_key.permission === 'string' ? k.access_key.permission : Object.keys(k.access_key.permission as object))));
};
let permissions = await permissionsOf();
for (let attempt = 0; attempt < 8 && permissions.includes('FullAccess'); attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  permissions = await permissionsOf();
}
console.log(`   the account now holds: ${permissions}`);
if (permissions.includes('FullAccess')) throw new Error('the full-access key is still present; refusing to call this account "restricted"');

// 3. the contract is pointed at the new agent -------------------------------
const setAgentTx = (await owner.signAndSendTransaction({
  receiverId: roles.owner.accountId,
  actions: [actions.functionCall('set_agent', { agent: newAccountId }, GAS, 0n)],
})) as { transaction_outcome?: { id?: string } };
console.log(`4. set_agent(new) by the owner                       ${setAgentTx.transaction_outcome?.id}`);

const config = (await owner.callFunction({ contractId: roles.owner.accountId, methodName: 'get_config', args: {} })) as { agent: string };
console.log(`   contract agent is now ${config.agent}`);
if (config.agent !== newAccountId) throw new Error('set_agent did not take effect');

roles.rotations = [...(roles.rotations ?? []), { accountId: newAccountId, at: new Date().toISOString(), reason: 'function-call key allowance exhausted' }];
roles.agent = newAccount;
roles.agentKey = { publicKey: restricted.getPublicKey().toString(), secretKey: restricted.toString() };
mkdirSync(join(root, 'data'), { recursive: true });
writeFileSync(rolesPath, JSON.stringify(roles, null, 2), 'utf8');
console.log('\nrotated. data/testnet-roles.json now points at the new agent.');
