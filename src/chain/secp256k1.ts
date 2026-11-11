/**
 * The small slice of secp256k1 Feral actually needs.
 *
 * The MPC returns `(r, s, recovery_id)` for a 32-byte payload. Comparing the
 * returned `r` to something is not verification: a forged signature recovers
 * *some* key too. This module recovers the public key and lets the caller
 * compare it with the key the MPC derived for the account. No dependency, no
 * native binding, no curve library with its own supply chain.
 *
 * This is verification only. Key generation and signing stay in the MPC.
 */

export const SECP256K1 = {
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn,
  n: 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n,
  gx: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  gy: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
} as const;

export interface Point {
  x: bigint;
  y: bigint;
}

export interface RecoverableSignature {
  r: bigint;
  s: bigint;
  recoveryId: number;
}

const mod = (value: bigint, m: bigint): bigint => ((value % m) + m) % m;

function modPow(base: bigint, exponent: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
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
  if (oldR !== 1n) throw new Error('value is not invertible');
  return mod(oldS, m);
}

export function pointAdd(a: Point | null, b: Point | null): Point | null {
  if (a === null) return b;
  if (b === null) return a;
  const { p } = SECP256K1;
  if (a.x === b.x) {
    if (mod(a.y + b.y, p) === 0n) return null;
    const slope = mod(3n * a.x * a.x * modInv(2n * a.y, p), p);
    const x = mod(slope * slope - 2n * a.x, p);
    return { x, y: mod(slope * (a.x - x) - a.y, p) };
  }
  const slope = mod((b.y - a.y) * modInv(b.x - a.x, p), p);
  const x = mod(slope * slope - a.x - b.x, p);
  return { x, y: mod(slope * (a.x - x) - a.y, p) };
}

export function pointMultiply(point: Point | null, scalar: bigint): Point | null {
  let result: Point | null = null;
  let addend = point;
  let k = mod(scalar, SECP256K1.n);
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointAdd(addend, addend);
    k >>= 1n;
  }
  return result;
}

export function pointNegate(point: Point): Point {
  return { x: point.x, y: mod(-point.y, SECP256K1.p) };
}

export function isOnCurve(point: Point): boolean {
  const { p } = SECP256K1;
  return mod(point.y * point.y, p) === mod(point.x * point.x * point.x + 7n, p);
}

export function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

export function bigIntToBytes(value: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function pointFromPublicKey(bytes: Uint8Array): Point {
  const raw = bytes.length === 65 && bytes[0] === 0x04 ? bytes.slice(1) : bytes;
  if (raw.length !== 64) throw new Error(`expected a 64-byte uncompressed key, got ${bytes.length} bytes`);
  const point = { x: bytesToBigInt(raw.slice(0, 32)), y: bytesToBigInt(raw.slice(32)) };
  if (!isOnCurve(point)) throw new Error('public key is not on secp256k1');
  return point;
}

/**
 * Recover the public key that produced `(r, s, recoveryId)` for `payloadHash`.
 *
 * The MPC signs the 32-byte payload directly, so `payloadHash` is not hashed
 * again. A wrong recovery id or a forged signature still returns a point; the
 * caller must compare it with the expected key.
 */
export function recoverPublicKey(payloadHash: Uint8Array, signature: RecoverableSignature): Point {
  const { p, n, gx, gy } = SECP256K1;
  const { r, s, recoveryId } = signature;
  if (payloadHash.length !== 32) throw new Error(`payload hash must be 32 bytes, got ${payloadHash.length}`);
  if (r <= 0n || r >= n) throw new Error('r is out of range');
  if (s <= 0n || s >= n) throw new Error('s is out of range');
  if (recoveryId < 0 || recoveryId > 3) throw new Error('recovery id must be 0..3');

  const x = r + (recoveryId >= 2 ? n : 0n);
  if (x >= p) throw new Error('recovered x is out of range');
  const alpha = mod(x * x * x + 7n, p);
  let y = modPow(alpha, (p + 1n) / 4n, p);
  if (mod(y * y, p) !== alpha) throw new Error('x is not on secp256k1');
  if (Number(y & 1n) !== (recoveryId & 1)) y = p - y;

  const rPoint: Point = { x, y };
  const e = mod(bytesToBigInt(payloadHash), n);
  const rInv = modInv(r, n);
  const sR = pointMultiply(rPoint, s);
  const eG = pointMultiply({ x: gx, y: gy }, e);
  const numerator = pointAdd(sR, pointNegate(eG));
  const q = pointMultiply(numerator, rInv);
  if (q === null || !isOnCurve(q)) throw new Error('recovery produced the point at infinity');
  return q;
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Verify that `signature` was produced by the key behind `publicKey`. */
export function verifySignature(payloadHash: Uint8Array, signature: RecoverableSignature, publicKey: Uint8Array): boolean {
  try {
    return samePoint(recoverPublicKey(payloadHash, signature), pointFromPublicKey(publicKey));
  } catch {
    return false;
  }
}
