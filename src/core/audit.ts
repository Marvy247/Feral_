/**
 * Append-only, tamper-evident audit log.
 *
 * Every decision — including denials — produces a record. Records are chained by
 * hash, so removing or editing one breaks the chain and `verify()` reports the
 * exact sequence number. The chain head is what a caller can anchor on-chain,
 * which turns "trust the dashboard" into "check the hash".
 */
import { canonicalJson, sha256Hex } from './canonical.ts';

export type Verdict = 'allow' | 'deny' | 'require_approval';

export interface AuditRecord {
  seq: number;
  at: string;
  actor: string;
  /** Agent the decision was attributed to (same as actor unless a governance act). */
  agent: string;
  actionId: string;
  kind: string;
  asset: string;
  amount: string;
  to: string | null;
  verdict: Verdict;
  reasons: string[];
  riskScore: number;
  policyHash: string;
  /** Agent reputation before and after this decision. */
  reputationBefore: number;
  reputationAfter: number;
  /** Anomaly score at decision time. */
  anomalyScore: number;
  /** Circuit breaker level in force for this decision. */
  circuitBreakerLevel: number;
  payloadHash: string;
  prevHash: string;
  hash: string;
}

export type AuditInput = Omit<AuditRecord, 'seq' | 'prevHash' | 'hash'> & {
  agent?: string;
  reputationBefore?: number;
  reputationAfter?: number;
  anomalyScore?: number;
  circuitBreakerLevel?: number;
};

export const GENESIS_HASH = '0'.repeat(64);

export function computeRecordHash(record: Omit<AuditRecord, 'hash'>): string {
  return sha256Hex(canonicalJson(record));
}

export interface VerifyResult {
  ok: boolean;
  records: number;
  head: string;
  brokenAt?: number;
  reason?: string;
}

export class AuditLog {
  private records: AuditRecord[] = [];

  get length(): number {
    return this.records.length;
  }

  head(): string {
    return this.records.length === 0 ? GENESIS_HASH : this.records[this.records.length - 1].hash;
  }

  append(input: AuditInput): AuditRecord {
    const seq = this.records.length + 1;
    const prevHash = this.head();
    const base: Omit<AuditRecord, 'hash'> = {
      ...input,
      agent: input.agent ?? input.actor,
      reputationBefore: input.reputationBefore ?? 0,
      reputationAfter: input.reputationAfter ?? 0,
      anomalyScore: input.anomalyScore ?? 0,
      circuitBreakerLevel: input.circuitBreakerLevel ?? 0,
      seq,
      prevHash,
    };
    const hash = computeRecordHash(base);
    const record: AuditRecord = { ...base, hash };
    this.records.push(record);
    return record;
  }

  all(): readonly AuditRecord[] {
    return this.records;
  }

  /** Full verification: recompute every hash and check every link. */
  verify(): VerifyResult {
    let prev = GENESIS_HASH;
    for (const record of this.records) {
      if (record.prevHash !== prev) {
        return { ok: false, records: this.records.length, head: this.head(), brokenAt: record.seq, reason: 'prevHash does not match the previous record' };
      }
      const { hash, ...rest } = record;
      const expected = computeRecordHash(rest);
      if (expected !== hash) {
        return { ok: false, records: this.records.length, head: this.head(), brokenAt: record.seq, reason: 'record content does not match its hash' };
      }
      prev = hash;
    }
    return { ok: true, records: this.records.length, head: this.head() };
  }

  toJSON(): AuditRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  static fromJSON(raw: unknown): AuditLog {
    const log = new AuditLog();
    if (!Array.isArray(raw)) return log;
    log.records = raw as AuditRecord[];
    return log;
  }
}
