/**
 * EIP-1559 transaction building, just enough for a signed testnet transfer.
 *
 * The MPC signs a 32-byte payload. For an EVM spend the payload is the
 * keccak-256 of the unsigned type-2 transaction. This module produces that
 * transaction, then reassembles the signed bytes from `(r, s, yParity)`.
 */
import { bigIntToBytes, bytesToBigInt, type RecoverableSignature } from './secp256k1.ts';
import { keccak256, toHex } from './chainsig.ts';

export type RlpItem = Uint8Array | RlpItem[];

export interface Eip1559Transfer {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: Uint8Array;
  value: bigint;
  data: Uint8Array;
}

export interface UnsignedEip1559 {
  tx: Eip1559Transfer;
  signingHash: Uint8Array;
  signingHashHex: string;
  fields: RlpItem[];
}

export interface MpcSignature {
  r: bigint;
  s: bigint;
  recoveryId: number;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex string has an odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + toHex(bytes);
}

function trimLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  return bytes.slice(start);
}

function integerBytes(value: bigint): Uint8Array {
  if (value < 0n) throw new Error('RLP integers must be non-negative');
  if (value === 0n) return new Uint8Array();
  const bytes = bigIntToBytes(value, 32);
  return trimLeadingZeros(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthPrefix(length: number, shortBase: number, longBase: number): Uint8Array {
  if (length <= 55) return Uint8Array.from([shortBase + length]);
  const lengthBytes = integerBytes(BigInt(length));
  return concat([Uint8Array.from([longBase + lengthBytes.length]), lengthBytes]);
}

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([lengthPrefix(item.length, 0x80, 0xb7), item]);
  }
  const payload = concat(item.map(rlpEncode));
  return concat([lengthPrefix(payload.length, 0xc0, 0xf7), payload]);
}

/** Encode a 20-byte EVM address; a 0x-prefixed string is accepted too. */
export function evmAddressBytes(address: string): Uint8Array {
  const bytes = hexToBytes(address);
  if (bytes.length !== 20) throw new Error(`expected a 20-byte address, got ${bytes.length} bytes`);
  return bytes;
}

export function buildEip1559Transfer(tx: Eip1559Transfer): UnsignedEip1559 {
  if (tx.to.length !== 20) throw new Error('tx.to must be 20 bytes');
  const fields: RlpItem[] = [
    integerBytes(tx.chainId),
    integerBytes(tx.nonce),
    integerBytes(tx.maxPriorityFeePerGas),
    integerBytes(tx.maxFeePerGas),
    integerBytes(tx.gasLimit),
    tx.to,
    integerBytes(tx.value),
    tx.data,
    [],
  ];
  const signingPayload = concat([Uint8Array.from([0x02]), rlpEncode(fields)]);
  const signingHash = keccak256(signingPayload);
  return { tx, signingHash, signingHashHex: toHex(signingHash), fields };
}

/** Reassemble the signed type-2 transaction: 0x02 || rlp(fields + [yParity, r, s]). */
export function serializeSignedEip1559(unsigned: UnsignedEip1559, signature: MpcSignature): Uint8Array {
  if (signature.recoveryId !== 0 && signature.recoveryId !== 1) {
    throw new Error(`EIP-1559 yParity must be 0 or 1, got ${signature.recoveryId}`);
  }
  const fields: RlpItem[] = [
    ...unsigned.fields,
    integerBytes(BigInt(signature.recoveryId)),
    integerBytes(signature.r),
    integerBytes(signature.s),
  ];
  return concat([Uint8Array.from([0x02]), rlpEncode(fields)]);
}

/**
 * Parse the MPC response shape:
 * `{ scheme: "Secp256k1", big_r: { affine_point: "03..." }, s: "..", recovery_id: n }`
 */
export function parseMpcSignature(response: unknown): MpcSignature {
  if (typeof response !== 'object' || response === null) throw new Error('MPC response is not an object');
  const value = response as Record<string, unknown>;
  const bigR = value.big_r as { affine_point?: unknown } | undefined;
  const affine = bigR?.affine_point;
  const rawS = value.s;
  // The signer returns either a hex string or `{ scalar: "..." }` depending on
  // the response version. Both are the same 32-byte ECDSA scalar.
  const s = typeof rawS === 'string' ? rawS : (rawS as { scalar?: unknown } | undefined)?.scalar;
  const recovery = value.recovery_id;
  if (typeof affine !== 'string' || typeof s !== 'string' || typeof recovery !== 'number') {
    throw new Error(`unexpected MPC signature shape: ${JSON.stringify(response)}`);
  }
  const point = hexToBytes(affine);
  if (point.length !== 33) throw new Error(`expected a 33-byte compressed point, got ${point.length}`);
  const r = bytesToBigInt(point.slice(1));
  const sValue = bytesToBigInt(hexToBytes(s));
  return { r, s: sValue, recoveryId: recovery };
}

export function signatureForRecovery(signature: MpcSignature): RecoverableSignature {
  return { r: signature.r, s: signature.s, recoveryId: signature.recoveryId };
}
