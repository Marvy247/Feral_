/**
 * Redeploy the current wasm to the existing public testnet vault and prove the
 * denial semantics on-chain.
 *
 * Node's fetch is unreliable from this environment, while curl reaches the RPC
 * consistently, so the provider talks to a tiny localhost proxy that shells out
 * to curl. Signing still happens in near-api-js; only transport changes.
 *
 *   node scripts/testnet-redeploy.ts
 */
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';

const RPC = 'https://archival-rpc.testnet.near.org';
const GAS = 100_000_000_000_000n;
const ONE_NEAR = 10n ** 24n;
const root = join(import.meta.dirname, '..');
const wasmPath = join(root, 'contract', 'res', 'feral_vault.wasm');
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
  transactions?: Record<string, string>;
}

function curlRpc(body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'curl',
      ['-sS', '-m', '45', '-X', 'POST', RPC, '-H', 'content-type: application/json', '--data-binary', '@-'],
      { maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`rpc curl failed: ${stderr || error.message}`));
        resolve(stdout);
      },
    );
    child.stdin?.end(body);
  });
}

const proxy = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  try {
    const body = Buffer.concat(chunks).toString('utf8');
    const payload = await curlRpc(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: 'proxy', error: { code: -1, message: String(err) } }));
  }
});
await new Promise<void>((resolve) => proxy.listen(3031, '127.0.0.1', resolve));

const provider = new JsonRpcProvider({ url: 'http://127.0.0.1:3031' });
const accountFor = (accountId: string, secretKey: string) =>
  new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(secretKey)));
const explorer = (hash: string) => `https://testnet.nearblocks.io/txns/${hash}`;
const txHash = (outcome: unknown): string =>
  (outcome as { transaction_outcome?: { id?: string } }).transaction_outcome?.id ?? 'unknown';

const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;
const ownerId = roles.owner.accountId;
const owner = accountFor(ownerId, roles.owner.secretKey);
const wasm = readFileSync(wasmPath);

const before = (await owner.callFunction({
  contractId: ownerId,
  methodName: 'check_reputation',
  args: { account: roles.agent.accountId },
})) as [number, { per_tx: string; daily: string; monthly: string }[]];
console.log(`reputation before: ${before[0]}`);
console.log(`effective limits: ${JSON.stringify(before[1])}`);

const decision = await owner.callFunction({
  contractId: ownerId,
  methodName: 'check',
  args: {
    agent: roles.agent.accountId,
    asset_id: 'near',
    amount: ((ONE_NEAR * 3n) / 2n).toString(),
    to: roles.vendor.accountId,
    action_kind: 'near.transfer',
    attestation_proof: null,
    destination: null,
  },
});
console.log(`preflight view for 1.5 NEAR: ${decision}`);

console.log('\ndeploying the new wasm...');
const deploy = await owner.signAndSendTransaction({
  receiverId: ownerId,
  actions: [actions.deployContract(wasm)],
});
const deployHash = txHash(deploy);
console.log(`  tx  ${deployHash}`);
console.log(`  url ${explorer(deployHash)}`);
await new Promise((resolve) => setTimeout(resolve, 4_000));

// The agent holds only a function-call key scoped to spend. A denied spend is
// now a successful receipt with allowed=false, so the reputation write persists.
const agent = accountFor(roles.agent.accountId, roles.agentKey.secretKey);
const deniedOutcome = await agent.signAndSendTransaction({
  receiverId: ownerId,
  actions: [
    actions.functionCall(
      'spend',
      {
        asset_id: 'near',
        amount: ((ONE_NEAR * 3n) / 2n).toString(),
        to: roles.vendor.accountId,
        action_kind: 'near.transfer',
        attestation_proof: null,
        decision_hash: null,
        destination: null,
      },
      GAS,
      0n,
    ),
  ],
});
const deniedHash = txHash(deniedOutcome);
console.log(`  denied spend tx  ${deniedHash}`);
console.log(`  url ${explorer(deniedHash)}`);

await new Promise((resolve) => setTimeout(resolve, 4_000));
const after = (await owner.callFunction({
  contractId: ownerId,
  methodName: 'check_reputation',
  args: { account: roles.agent.accountId },
})) as [number, unknown[]];
const agents = (await owner.callFunction({
  contractId: ownerId,
  methodName: 'get_agents',
  args: {},
})) as { account: string; reputation: number; deny_count: number }[];
const agentState = agents.find((entry) => entry.account === roles.agent.accountId);
console.log(`\nreputation after: ${after[0]}`);
console.log(`agent state: ${JSON.stringify(agentState)}`);

roles.transactions = {
  ...roles.transactions,
  redeploy: deployHash,
  deniedSpend: deniedHash,
};
writeFileSync(rolesPath, JSON.stringify(roles, null, 2), 'utf8');

if (after[0] !== before[0] - 10 || agentState?.reputation !== after[0]) {
  console.error('FAIL: the denial did not persist a -10 reputation penalty on-chain');
  proxy.close();
  process.exit(1);
}
console.log(`PASS: denial persisted reputation ${before[0]} -> ${after[0]} on-chain, no funds moved`);
proxy.close();
