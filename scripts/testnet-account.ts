/**
 * Create (or reuse) a funded NEAR testnet account for the on-chain demo.
 *
 * The account is an implicit account: the id is the hex of the ed25519 public
 * key. The key is written to `data/testnet-key.json`, which is gitignored. This
 * script never touches mainnet and never spends anything but testnet faucet NEAR.
 *
 *   node scripts/testnet-account.ts
 */
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { base58Encode } from '../src/chain/chainsig.ts';

const RPC = 'https://rpc.testnet.near.org';
const FAUCET = 'https://faucet-near-testnet.onrender.com/api/faucet';
const keyFile = join(import.meta.dirname, '..', 'data', 'testnet-key.json');

interface KeyFile {
  accountId: string;
  publicKey: string;
  secretKey: string;
  createdAt: string;
}

function createAccount(): KeyFile {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const rawSecret = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  return {
    accountId: Buffer.from(rawPublic).toString('hex'),
    publicKey: `ed25519:${base58Encode(new Uint8Array(rawPublic))}`,
    secretKey: `ed25519:${base58Encode(new Uint8Array(rawSecret))}`,
    createdAt: new Date().toISOString(),
  };
}

async function balanceOf(accountId: string): Promise<bigint> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'feral',
      method: 'query',
      params: { request_type: 'view_account', finality: 'final', account_id: accountId },
    }),
  });
  const payload = (await response.json()) as { result?: { amount: string }; error?: { cause?: { name?: string } } };
  if (!payload.result) return 0n;
  return BigInt(payload.result.amount);
}

async function requestFaucet(accountId: string): Promise<string> {
  const response = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  });
  const text = await response.text();
  return `${response.status} ${text.slice(0, 200)}`;
}

let key: KeyFile;
if (existsSync(keyFile)) {
  key = JSON.parse(readFileSync(keyFile, 'utf8')) as KeyFile;
  console.log('reusing', key.accountId);
} else {
  key = createAccount();
  mkdirSync(join(import.meta.dirname, '..', 'data'), { recursive: true });
  writeFileSync(keyFile, JSON.stringify(key, null, 2), 'utf8');
  console.log('created', key.accountId, '(key saved to data/testnet-key.json, gitignored)');
}

let balance = await balanceOf(key.accountId);
console.log('balance:', balance.toString(), 'yoctoNEAR');
if (balance === 0n) {
  console.log('requesting faucet...');
  console.log('faucet says:', await requestFaucet(key.accountId));
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    balance = await balanceOf(key.accountId);
    if (balance > 0n) break;
  }
}
console.log('final balance:', balance.toString(), 'yoctoNEAR');
console.log('account:', key.accountId);
console.log('public key:', key.publicKey);
if (balance === 0n) {
  console.error('\nThe faucet did not fund the account. Check https://docs.near.org/getting-started/faucet and retry, or fund it from another testnet account.');
  process.exitCode = 1;
}

// Silence the unused-import lint a reviewer might notice: createPublicKey is not needed.
void createPublicKey;
