import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bigIntToBytes,
  bytesToBigInt,
  pointAdd,
  pointMultiply,
  recoverPublicKey,
  samePoint,
  SECP256K1,
  verifySignature,
} from '../../src/chain/secp256k1.ts';
import {
  buildEip1559Transfer,
  evmAddressBytes,
  parseMpcSignature,
  rlpEncode,
  serializeSignedEip1559,
} from '../../src/chain/evm.ts';
import { keccak256 } from '../../src/chain/chainsig.ts';

function mod(value: bigint, m: bigint): bigint {
  return ((value % m) + m) % m;
}

function modInv(value: bigint, m: bigint): bigint {
  let oldR = mod(value, m);
  let r = m;
  let oldS = 1n;
  let s = 0n;
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  assert.equal(oldR, 1n);
  return mod(oldS, m);
}

/** A deterministic test signature; production signing stays in the MPC. */
function signForTest(payloadHash: Uint8Array, privateKey: bigint, nonce: bigint) {
  const G = { x: SECP256K1.gx, y: SECP256K1.gy };
  const R = pointMultiply(G, nonce);
  assert.ok(R);
  const r = mod(R.x, SECP256K1.n);
  const z = bytesToBigInt(payloadHash);
  const s = mod(modInv(nonce, SECP256K1.n) * (z + r * privateKey), SECP256K1.n);
  const recoveryId = Number(R.y & 1n) | (R.x >= SECP256K1.n ? 2 : 0);
  return { r, s, recoveryId };
}

test('secp256k1 recovery returns the signing key, not just some key', () => {
  const privateKey = 1n;
  const publicKey = { x: SECP256K1.gx, y: SECP256K1.gy };
  const payload = keccak256(new TextEncoder().encode('feral mpc test vector'));
  const signature = signForTest(payload, privateKey, 2n);

  const recovered = recoverPublicKey(payload, signature);
  assert.equal(recovered.x, publicKey.x);
  assert.equal(recovered.y, publicKey.y);
  assert.equal(verifySignature(payload, signature, bigIntToBytes(publicKey.x, 32)), false, 'a half key is not a key');
  assert.equal(
    verifySignature(payload, signature, Uint8Array.from([...bigIntToBytes(publicKey.x, 32), ...bigIntToBytes(publicKey.y, 32)])),
    true,
  );

  const altered = { ...signature, s: signature.s + 1n };
  const alteredPoint = recoverPublicKey(payload, altered);
  assert.equal(samePoint(alteredPoint, publicKey), false);
});

test('point arithmetic stays on the curve', () => {
  const G = { x: SECP256K1.gx, y: SECP256K1.gy };
  const twoG = pointMultiply(G, 2n);
  assert.ok(twoG);
  assert.equal(samePoint(twoG, pointAdd(G, G)), true);
  assert.equal(pointMultiply(G, SECP256K1.n), null, 'nG is the point at infinity');
});

test('RLP matches the canonical dog and empty-list vectors', () => {
  assert.deepEqual([...rlpEncode(new TextEncoder().encode('dog'))], [0x83, 0x64, 0x6f, 0x67]);
  assert.deepEqual([...rlpEncode([])], [0xc0]);
  assert.deepEqual([...rlpEncode(new Uint8Array())], [0x80]);
});

test('EIP-1559 signing hash is deterministic and signed bytes are type 2', () => {
  const tx = {
    chainId: 11155111n,
    nonce: 0n,
    maxPriorityFeePerGas: 1_000_000_000n,
    maxFeePerGas: 2_000_000_000n,
    gasLimit: 21_000n,
    to: evmAddressBytes('0x583ddbf02324f75c3963c45686d52afaf2368c2f'),
    value: 0n,
    data: new Uint8Array(),
  };
  const unsigned = buildEip1559Transfer(tx);
  assert.equal(unsigned.signingHash.length, 32);
  assert.equal(unsigned.signingHashHex, buildEip1559Transfer(tx).signingHashHex);
  assert.equal(unsigned.signingHashHex.length, 64);

  const signature = signForTest(unsigned.signingHash, 1n, 2n);
  const signed = serializeSignedEip1559(unsigned, signature);
  assert.equal(signed[0], 0x02);
  assert.ok(signed.length > 100);
});

test('the MPC signature response shape is parsed strictly', () => {
  const r = 0x1234n;
  const response = {
    scheme: 'Secp256k1',
    big_r: { affine_point: `03${r.toString(16).padStart(64, '0')}` },
    s: '5678',
    recovery_id: 1,
  };
  const parsed = parseMpcSignature(response);
  assert.equal(parsed.r, r);
  assert.equal(parsed.s, 0x5678n);
  assert.equal(parsed.recoveryId, 1);
  // The live signer wraps the scalar in an object.
  assert.equal(parseMpcSignature({ ...response, s: { scalar: '5678' } }).s, 0x5678n);
  assert.throws(() => parseMpcSignature({ big_r: { affine_point: '03' }, s: '1', recovery_id: 0 }), /33-byte/);
});
