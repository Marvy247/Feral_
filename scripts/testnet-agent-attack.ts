/**
 * The prompt-injection refusal, on the real testnet vault.
 *
 * The local `npm run agent:attack` shows the agent's planner being fooled three
 * times. This script takes the first injected payment and sends it through the
 * deployed contract with the agent's restricted key. The contract must return
 * `allowed:false` with `RECIPIENT_NOT_ALLOWED`, move no funds, and still persist
 * the reputation penalty.
 *
 * Testnet only. Uses the restricted agent key from data/testnet-roles.json.
 *
 *   npm run chain:agent-attack
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, actions, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { hashObject } from '../src/core/canonical.ts';
import { UNTRUSTED_VENDOR_PAGE, INJECTED_ACCOUNT } from '../src/demo/prompt-injection.ts';

const RPC = process.env.FERAL_RPC ?? 'https://rpc.testnet.near.org';
const GAS = 100_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');

if (!existsSync(rolesPath)) {
  console.error('no data/testnet-roles.json. Run `npm run chain:demo` first.');
  process.exit(2);
}

interface Roles {
  owner: { accountId: string; secretKey: string };
  vendor: { accountId: string };
  agent: { accountId: string };
  agentKey?: { publicKey: string; secretKey: string };
  transactions?: Record<string, string>;
}

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
if (!roles.agentKey) {
  console.error('no restricted agent key recorded. Run `npm run chain:demo` first.');
  process.exit(2);
}

const provider = new JsonRpcProvider({ url: RPC });
const owner = new Account(roles.owner.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)));
const agent = new Account(roles.agent.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.agentKey.secretKey)));
const explorer = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

const readReputation = async (): Promise<number> => {
  const value = await owner.callFunction({
    contractId: roles.owner.accountId,
    methodName: 'check_reputation',
    args: { account: roles.agent.accountId },
  });
  return Number((value as unknown[])[0]);
};

const action = {
  asset_id: 'near',
  amount: (ONE_NEAR / 4n).toString(),
  to: INJECTED_ACCOUNT,
  action_kind: 'near.transfer',
  attestation_proof: null,
  destination: null,
};
const decisionHash = hashObject({
  source: 'untrusted-vendor-page',
  prompt: UNTRUSTED_VENDOR_PAGE,
  action,
});

console.log('');
console.log('FERAL - prompt-injection denial on testnet');
console.log(`  vault ${roles.owner.accountId}`);
console.log(`  agent ${roles.agent.accountId}`);
console.log(`  injected recipient ${INJECTED_ACCOUNT}`);
console.log('');

let reputationBefore: number;
try {
  reputationBefore = await readReputation();
} catch (err) {
  console.error(`  NEAR RPC unavailable (${(err as Error).message}); no transaction was sent and nothing is claimed.`);
  process.exit(2);
}
console.log(`  reputation before: ${reputationBefore}`);
console.log('  agent calls spend(0.25 NEAR) after following the injected page...');

interface Execution {
  status?: { SuccessValue?: string };
  transaction_outcome?: { id?: string };
}

let outcome: Record<string, unknown>;
let hash: string;
try {
  const result = (await agent.signAndSendTransaction({
    receiverId: roles.owner.accountId,
    actions: [
      actions.functionCall('spend', { ...action, decision_hash: decisionHash }, GAS, 0n),
    ],
  })) as Execution;
  hash = result.transaction_outcome?.id ?? 'unknown';
  const encoded = result.status?.SuccessValue;
  if (!encoded) throw new Error('spend returned no SuccessValue');
  outcome = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, unknown>;
} catch (err) {
  console.error(`  REJECTED before execution: ${(err as Error).message}`);
  process.exit(1);
}

console.log(`  tx   ${hash}`);
console.log(`  url  ${explorer(hash)}`);
console.log(`  result ${JSON.stringify(outcome)}`);

const allowed = outcome.allowed;
const reason = outcome.reason;
let reputationAfter: number;
try {
  reputationAfter = await readReputation();
} catch (err) {
  console.error(`  transaction sent, but the state read failed: ${(err as Error).message}`);
  process.exit(1);
}
console.log(`  reputation after:  ${reputationAfter}`);

if (allowed !== false) {
  console.error(`  FAIL: expected allowed:false, got ${JSON.stringify(allowed)}`);
  process.exit(1);
}
if (reason !== 'RECIPIENT_NOT_ALLOWED') {
  console.error(`  FAIL: expected RECIPIENT_NOT_ALLOWED, got ${String(reason)}`);
  process.exit(1);
}
if (!(reputationAfter < reputationBefore)) {
  console.error(`  FAIL: denial did not persist a reputation penalty: ${reputationBefore} -> ${reputationAfter}`);
  process.exit(1);
}

const evidence = {
  network: 'testnet',
  vault: roles.owner.accountId,
  agent: roles.agent.accountId,
  injectedRecipient: INJECTED_ACCOUNT,
  amountYoctoNear: action.amount,
  transaction: hash,
  explorer: explorer(hash),
  decisionHash,
  result: outcome,
  reputation: { before: reputationBefore, after: reputationAfter },
  prompt: UNTRUSTED_VENDOR_PAGE,
  checkedAt: new Date().toISOString(),
};
writeFileSync(join(root, 'data', 'testnet-agent-attack.json'), JSON.stringify(evidence, null, 2), 'utf8');

console.log('');
console.log('  PASS: on-chain denial, no funds moved, reputation penalty persisted');
console.log('  evidence written to data/testnet-agent-attack.json');
