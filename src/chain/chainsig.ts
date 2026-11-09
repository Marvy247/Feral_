/**
 * Chain Signatures (NEAR MPC) helpers.
 *
 * A NEAR account can own an address on another chain: the MPC network holds the
 * key share, and `v1.signer` derives the public key from
 * `(predecessor, path)`. Feral uses this to answer a question every swap policy
 * needs: "what is the only address this agent may ever receive funds on?"
 *
 * The answer is derived, not typed. The policy pins the address; the README shows
 * that the pinned address is exactly the MPC-derived address of the agent account,
 * so a redirected swap is detectable by construction.
 *
 * Crypto here is dependency-free on purpose (keccak-256 + base58), and covered by
 * test vectors in test/unit/chainsig.test.ts.
 */

export const SIGNER_ACCOUNTS = {
  mainnet: 'v1.signer',
  testnet: 'v1.signer-prod.testnet',
} as const;

export type NearNetwork = keyof typeof SIGNER_ACCOUNTS;

export const RPC_ENDPOINTS: Record<NearNetwork, string> = {
  mainnet: 'https://free.rpc.fastnear.com',
  testnet: 'https://rpc.testnet.near.org',
};

/**
 * Public RPC endpoints are best-effort: the free mainnet endpoint intermittently
 * resets connections. A key derivation is read-only, so trying a second public
 * endpoint is safe and does not weaken the address comparison.
 */
export const RPC_FALLBACKS: Record<NearNetwork, readonly string[]> = {
  mainnet: ['https://rpc.mainnet.near.org'],
  testnet: ['https://archival-rpc.testnet.near.org'],
};

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map([...BASE58_ALPHABET].map((char, index) => [char, BigInt(index)]));

export function base58Decode(input: string): Uint8Array {
  let value = 0n;
  for (const char of input) {
    const digit = BASE58_MAP.get(char);
    if (digit === undefined) throw new Error(`invalid base58 character: ${char}`);
    value = value * 58n + digit;
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Leading '1' characters encode leading zero bytes.
  for (const char of input) {
    if (char !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

// ---------------------------------------------------------------------------
// keccak-256 (the pre-standard padding Ethereum uses, not NIST SHA3-256)
// ---------------------------------------------------------------------------

const MASK = (1n << 64n) - 1n;

const ROUND_CONSTANTS: bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

// Rotation offsets, indexed [x][y].
const ROTATIONS: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(value: bigint, shift: number): bigint {
  const s = BigInt(shift % 64);
  if (s === 0n) return value & MASK;
  return ((value << s) | (value >> (64n - s))) & MASK;
}

function keccakF1600(state: bigint[]): void {
  const c = new Array<bigint>(5);
  const b = new Array<bigint>(25);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) state[x + y] ^= d;
    }
    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const index = x + 5 * y;
        const target = y + 5 * ((2 * x + 3 * y) % 5);
        b[target] = rotl(state[index], ROTATIONS[x][y]);
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        state[x + y] = b[x + y] ^ (~b[((x + 1) % 5) + y] & MASK & b[((x + 2) % 5) + y]);
      }
    }
    // iota
    state[0] ^= ROUND_CONSTANTS[round];
  }
}

export function keccak256(input: Uint8Array): Uint8Array {
  const rate = 136;
  const state = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.floor(input.length / rate) * rate + rate);
  padded.set(input);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i += 8) {
      let lane = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        lane = (lane << 8n) | BigInt(padded[offset + i + byte]);
      }
      state[i / 8] ^= lane;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let byte = 0; byte < 8; byte++) {
      out[i * 8 + byte] = Number((state[i] >> BigInt(8 * byte)) & 0xffn);
    }
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Address derivation
// ---------------------------------------------------------------------------

/**
 * Derive the EVM address from a secp256k1 public key.
 *
 * The MPC returns the key as base58. A 64-byte blob is the uncompressed key
 * without the 0x04 prefix; a 33-byte blob is compressed and is rejected here
 * because decompressing it needs secp256k1 field arithmetic we deliberately do
 * not carry in a policy tool.
 */
export function evmAddressFromPublicKey(publicKey: Uint8Array): string {
  let uncompressed = publicKey;
  if (uncompressed.length === 65 && uncompressed[0] === 0x04) {
    uncompressed = uncompressed.slice(1);
  }
  if (uncompressed.length !== 64) {
    throw new Error(`expected a 64-byte uncompressed secp256k1 key, got ${publicKey.length} bytes`);
  }
  const digest = keccak256(uncompressed);
  return '0x' + toHex(digest.slice(12));
}

export interface DerivedKey {
  publicKey: string;
  bytes: Uint8Array;
  evmAddress: string;
}

// Public NEAR RPC endpoints intermittently reset connections. A read-only key
// derivation is safe to retry, and a retry does not weaken the check: only a
// well-formed signer response is returned, and the caller still compares the
// derived address with the pinned destination. Deterministic JSON-RPC errors
// (no such key, wrong signer) are not retried.
const RPC_ATTEMPTS = 3;
const RPC_BACKOFF_MS = [0, 400, 900];

async function queryDerivedKey(rpc: string, requestBody: string): Promise<{ result?: { result?: number[] }; error?: { message?: string } }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < RPC_ATTEMPTS; attempt++) {
    if (RPC_BACKOFF_MS[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, RPC_BACKOFF_MS[attempt]));
    try {
      const response = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: requestBody,
      });
      if (response.status >= 500) throw new Error(`RPC returned HTTP ${response.status}`);
      return (await response.json()) as { result?: { result?: number[] }; error?: { message?: string } };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`could not reach ${rpc} after ${RPC_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? String(lastError)}`);
}

/** Derive the MPC public key for `(predecessor, path)` by a read-only RPC call. */
export async function derivedPublicKey(options: {
  account: string;
  path: string;
  network?: NearNetwork;
  keyVersion?: number;
  rpc?: string;
}): Promise<DerivedKey> {
  const network = options.network ?? 'testnet';
  const args = { path: options.path, predecessor: options.account, key_version: options.keyVersion ?? 0 };
  const requestBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 'feral',
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: SIGNER_ACCOUNTS[network],
      method_name: 'derived_public_key',
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    },
  });
  const endpoints = options.rpc ? [options.rpc] : [RPC_ENDPOINTS[network], ...RPC_FALLBACKS[network]];
  let payload: Awaited<ReturnType<typeof queryDerivedKey>> | null = null;
  let lastError: unknown = null;
  for (const rpc of endpoints) {
    try {
      const candidate = await queryDerivedKey(rpc, requestBody);
      if (candidate.result?.result) {
        payload = candidate;
        break;
      }
      // A JSON-RPC error (rate limit, unsupported method) is endpoint-specific;
      // try the next endpoint before giving up.
      lastError = new Error(`derived_public_key failed at ${rpc}: ${candidate.error?.message ?? 'no result'}`);
    } catch (err) {
      lastError = err;
    }
  }
  if (payload === null) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  const asText = Buffer.from(payload.result.result).toString('utf8').replace(/^"|"$/g, '');
  const [scheme, encoded] = asText.split(':');
  if (scheme !== 'secp256k1') throw new Error(`unsupported key scheme: ${scheme}`);
  const bytes = base58Decode(encoded);
  return { publicKey: asText, bytes, evmAddress: evmAddressFromPublicKey(bytes) };
}
