import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: object keys sorted, undefined dropped.
 *
 * Two processes that hold the same policy must produce the same hash, because
 * the hash is what the on-chain contract and the audit log commit to.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v === undefined) continue;
    out[key] = sortKeys(v);
  }
  return out;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashObject(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function shortHash(hash: string, length = 12): string {
  return hash.slice(0, length);
}
