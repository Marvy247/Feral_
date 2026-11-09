import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  base58Decode,
  base58Encode,
  derivedPublicKey,
  evmAddressFromPublicKey,
  keccak256,
  toHex,
} from '../../src/chain/chainsig.ts';

const hex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'));

test('keccak256 matches the published vectors', () => {
  // These are the canonical Ethereum keccak-256 vectors, not NIST SHA3-256.
  assert.equal(toHex(keccak256(new Uint8Array())), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(toHex(keccak256(new TextEncoder().encode('abc'))), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  assert.equal(
    toHex(keccak256(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))),
    '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
  );
});

test('keccak256 handles input longer than one rate block', () => {
  const long = new TextEncoder().encode('a'.repeat(200));
  assert.equal(toHex(keccak256(long)).length, 64);
  // A 136-byte block boundary must not collide with the padded short input.
  assert.notEqual(toHex(keccak256(new TextEncoder().encode('a'.repeat(135)))), toHex(keccak256(new TextEncoder().encode('a'.repeat(136)))));
});

test('base58 round-trips', () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 3, 255, 254]);
  assert.deepEqual(base58Decode(base58Encode(bytes)), bytes);
});

test('EVM address derivation matches the secp256k1 private key 1 vector', () => {
  // pubkey for private key 0x1; its Ethereum address is well known.
  const pubkey = hex('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8');
  assert.equal(evmAddressFromPublicKey(pubkey), '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
});

test('a compressed key is refused instead of guessed', () => {
  assert.throws(() => evmAddressFromPublicKey(new Uint8Array(33).fill(2)), /64-byte/);
});

test('the MPC derives a stable address for (account, path)', async (t) => {
  let key;
  try {
    key = await derivedPublicKey({ account: 'argo.testnet', path: 'ethereum-1', network: 'testnet' });
  } catch (err) {
    t.skip(`no network access to the signer contract: ${(err as Error).message}`);
    return;
  }
  assert.match(key.publicKey, /^secp256k1:/);
  assert.match(key.evmAddress, /^0x[0-9a-f]{40}$/);
  const again = await derivedPublicKey({ account: 'argo.testnet', path: 'ethereum-1', network: 'testnet' });
  assert.equal(again.evmAddress, key.evmAddress);
  const other = await derivedPublicKey({ account: 'argo.testnet', path: 'ethereum-2', network: 'testnet' });
  assert.notEqual(other.evmAddress, key.evmAddress, 'a different path must give a different address');
});
