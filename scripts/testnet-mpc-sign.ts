/**
 * Live NEAR chain-signature path.
 *
 * The MPC derives an Ethereum address for `(owner account, path)`. This script
 * then builds a real EIP-1559 transfer, asks `v1.signer-prod.testnet` to sign
 * its 32-byte hash, recovers the public key from `(r, s, recovery_id)`, and
 * compares it with the derived key. A signature that does not recover to the
 * expected key is rejected.
 *
 * The signed transaction is written to data/testnet-mpc.json. It is **not
 * broadcast** unless `FERAL_BROADCAST=1`. Broadcast can still fail on gas if the
 * derived address is unfunded; the signed bytes and the node's exact rejection
 * remain the evidence, and nothing is claimed beyond that.
 *
 *   npm run chain:mpc
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { derivedPublicKey, keccak256, SIGNER_ACCOUNTS, toHex } from '../src/chain/chainsig.ts';
import { buildEip1559Transfer, parseMpcSignature, evmAddressBytes, serializeSignedEip1559, signatureForRecovery, bytesToHex } from '../src/chain/evm.ts';
import { recoverPublicKey, samePoint, pointFromPublicKey } from '../src/chain/secp256k1.ts';

// Public endpoints are best-effort. A read or a retry is safe; the signed
// transaction is only broadcast once, after the signature has been verified.
const NEAR_RPCS = [
  process.env.FERAL_NEAR_RPC,
  'https://rpc.testnet.fastnear.com',
  'https://rpc.testnet.near.org',
].filter((value): value is string => Boolean(value));
// Keep the trailing slash: this endpoint answers a bare POST with a 301 that
// fetch follows as GET, which loses the JSON-RPC body.
const EVM_RPCS = [
  process.env.FERAL_EVM_RPC,
  'https://ethereum-sepolia-rpc.publicnode.com/',
  'https://1rpc.io/sepolia',
].filter((value): value is string => Boolean(value));
const EVM_RPC = EVM_RPCS[0];
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const PATH = process.env.FERAL_MPC_PATH ?? 'ethereum-1';
const NETWORK = (process.env.FERAL_MPC_NETWORK === 'mainnet' ? 'mainnet' : 'testnet') as 'mainnet' | 'testnet';
const CHAIN_ID = 11155111n; // Sepolia
// A neutral EOA for the broadcast proof. A plain transfer to the fixture
// destination reverted on Sepolia, so it is not used for the spend evidence.
const EVM_TO = process.env.FERAL_EVM_TO ?? '0x000000000000000000000000000000000000dEaD';
const EVM_VALUE = 1n; // one wei; the point is the signed transfer, not the amount
const root = join(import.meta.dirname, '..');
const rolesPath = join(root, 'data', 'testnet-roles.json');

if (!existsSync(rolesPath)) {
  console.error('no data/testnet-roles.json. Run `npm run chain:demo` first.');
  process.exit(2);
}

interface Roles {
  owner: { accountId: string; secretKey: string };
  agent: { accountId: string };
}
const roles = JSON.parse(readFileSync(rolesPath, 'utf8')) as Roles;

let evmRpcUsed: string | null = null;

async function evmRpc<T>(method: string, params: unknown[]): Promise<T | null> {
  for (const endpoint of EVM_RPCS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as { result?: T; error?: { message?: string } };
      if (payload.error) continue;
      if (payload.result !== undefined) {
        evmRpcUsed = endpoint;
        return payload.result;
      }
    } catch {
      // Try the next public endpoint.
    }
  }
  return null;
}

function accountFor(rpc: string): Account {
  return new Account(
    roles.owner.accountId,
    new JsonRpcProvider({ url: rpc }),
    new KeyPairSigner(KeyPair.fromString(roles.owner.secretKey)),
  );
}

console.log('');
console.log('FERAL - MPC signing path');
console.log(`  NEAR account ${roles.owner.accountId}`);
console.log(`  signer       ${SIGNER_ACCOUNTS[NETWORK]}`);
console.log(`  path         ${PATH}`);
console.log('');

let derived: Awaited<ReturnType<typeof derivedPublicKey>> | null = null;
let nearRpcUsed = '';
let deriveError: unknown = null;
for (const rpc of NEAR_RPCS) {
  try {
    derived = await derivedPublicKey({
      account: roles.owner.accountId,
      path: PATH,
      network: NETWORK,
      rpc,
    });
    nearRpcUsed = rpc;
    break;
  } catch (err) {
    deriveError = err;
  }
}
if (!derived) {
  console.error(`  could not derive the MPC key: ${(deriveError as Error)?.message ?? String(deriveError)}`);
  process.exit(1);
}

console.log(`  public key   ${derived.publicKey}`);
console.log(`  EVM address  ${derived.evmAddress}`);

const nonceHex = await evmRpc<string>('eth_getTransactionCount', [derived.evmAddress, 'pending']);
const balanceHex = await evmRpc<string>('eth_getBalance', [derived.evmAddress, 'latest']);
const nonce = nonceHex ? BigInt(nonceHex) : 0n;
const balance = balanceHex ? BigInt(balanceHex) : 0n;
console.log(`  nonce        ${nonce}${nonceHex ? '' : ' (Sepolia RPC unavailable; using 0)'}`);
console.log(`  balance      ${balance} wei${balanceHex ? '' : ' (Sepolia RPC unavailable)'}`);
console.log(`  recipient    ${EVM_TO}`);
console.log(`  value        ${EVM_VALUE} wei`);

const unsigned = buildEip1559Transfer({
  chainId: CHAIN_ID,
  nonce,
  maxPriorityFeePerGas: 1_000_000_000n,
  maxFeePerGas: 2_000_000_000n,
  gasLimit: 21_000n,
  to: evmAddressBytes(EVM_TO),
  value: EVM_VALUE,
  data: new Uint8Array(),
});
console.log(`  signing hash ${unsigned.signingHashHex}`);

let response: unknown;
let signerRpcUsed = '';
let signError: unknown = null;
const signerRpcs = [...new Set([nearRpcUsed, ...NEAR_RPCS])];
for (const rpc of signerRpcs) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await accountFor(rpc).callFunction({
        contractId: SIGNER_ACCOUNTS[NETWORK],
        methodName: 'sign',
        args: {
          request: {
            payload_v2: { Ecdsa: unsigned.signingHashHex },
            path: PATH,
            domain_id: 0,
          },
        },
        gas: 100_000_000_000_000n,
        deposit: 1n,
      });
      signerRpcUsed = rpc;
      break;
    } catch (err) {
      signError = err;
      await sleep(400 * (attempt + 1));
    }
  }
  if (response !== undefined) break;
}
if (response === undefined) {
  console.error(`  MPC request failed: ${(signError as Error)?.message ?? String(signError)}`);
  console.error('  no signature was produced; nothing is claimed');
  process.exit(1);
}

const outcome = response as { transaction_outcome?: { id?: string }; transaction?: { hash?: string } };
const mpcTransaction = outcome.transaction_outcome?.id ?? outcome.transaction?.hash;
if (mpcTransaction) console.log(`  NEAR tx      ${mpcTransaction}`);

const signature = parseMpcSignature(response);
const recovered = recoverPublicKey(unsigned.signingHash, signatureForRecovery(signature));
const expected = pointFromPublicKey(derived.bytes);
if (!samePoint(recovered, expected)) {
  console.error('  FAIL: the signature does not recover to the MPC-derived key');
  process.exit(1);
}
console.log(`  signature    r=${signature.r.toString(16).slice(0, 16)}... s=${signature.s.toString(16).slice(0, 16)}... v=${signature.recoveryId}`);
console.log('  verified     recovered public key matches the derived key');

const signed = serializeSignedEip1559(unsigned, signature);
const signedHex = bytesToHex(signed);
const signedHash = toHex(keccak256(signed));
console.log(`  signed tx    0x${signedHash}`);
console.log(`  bytes        ${signed.length}`);

interface BroadcastResult {
  attempted: boolean;
  hash?: string;
  error?: string;
  code?: number;
  endpoint?: string;
}

async function broadcastRaw(raw: string): Promise<{ hash?: string; error?: string; code?: number; endpoint?: string }> {
  let lastError = 'no Sepolia RPC endpoint responded';
  for (const endpoint of EVM_RPCS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
        signal: AbortSignal.timeout(15_000),
      });
      const payload = (await response.json()) as {
        result?: string;
        error?: { code?: number; message?: string };
      };
      if (payload.error) {
        // A deterministic rejection (bad signature, insufficient funds) does
        // not improve on another endpoint, so report it instead of retrying.
        return {
          error: payload.error.message ?? JSON.stringify(payload.error),
          code: payload.error.code,
          endpoint,
        };
      }
      if (payload.result) return { hash: payload.result, endpoint };
      lastError = 'empty RPC response';
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { error: lastError };
}

let broadcast: BroadcastResult = { attempted: false };
if (process.env.FERAL_BROADCAST === '1') {
  broadcast.attempted = true;
  const sent = await broadcastRaw(signedHex);
  if (sent.hash) {
    broadcast.hash = sent.hash;
    console.log(`  broadcast    ${sent.hash}`);
  } else {
    broadcast.error = sent.error;
    broadcast.code = sent.code;
    broadcast.endpoint = sent.endpoint;
    console.log(`  broadcast    rejected by ${sent.endpoint ?? EVM_RPC}: ${sent.error ?? 'unknown error'}`);
    console.log('  no state changed; the signed bytes are still the evidence');
  }
} else {
  console.log('  broadcast    skipped (set FERAL_BROADCAST=1 to submit; it needs gas)');
}

const evidence = {
  network: NETWORK,
  nearAccount: roles.owner.accountId,
  nearRpc: nearRpcUsed,
  signerRpc: signerRpcUsed,
  signer: SIGNER_ACCOUNTS[NETWORK],
  mpcTransaction,
  path: PATH,
  derivedPublicKey: derived.publicKey,
  evmAddress: derived.evmAddress,
  chainId: CHAIN_ID.toString(),
  nonce: nonce.toString(),
  balanceWei: balance.toString(),
  recipient: EVM_TO,
  valueWei: EVM_VALUE.toString(),
  signingHash: unsigned.signingHashHex,
  signature: { r: signature.r.toString(16), s: signature.s.toString(16), recoveryId: signature.recoveryId },
  recoveredPublicKey: `04${recovered.x.toString(16).padStart(64, '0')}${recovered.y.toString(16).padStart(64, '0')}`,
  signedTransaction: signedHex,
  signedTransactionHash: `0x${signedHash}`,
  evmRpc: evmRpcUsed ?? broadcast.endpoint ?? null,
  broadcast,
  checkedAt: new Date().toISOString(),
};
writeFileSync(join(root, 'data', 'testnet-mpc.json'), JSON.stringify(evidence, null, 2), 'utf8');
console.log('  evidence     data/testnet-mpc.json');
console.log('');
console.log('  PASS: MPC produced a signature and it recovers to the derived key');
