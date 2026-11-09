/**
 * Spend ledger: what the agent has already spent, what is reserved, and what has
 * already been attempted.
 *
 * Two properties matter for safety:
 *  - reservations. A decision that needs human approval still occupies budget,
 *    so ten pending approvals cannot be used to spend the same budget ten times.
 *  - replay protection. An action id is single-use; a replayed request is a denial.
 *
 * Amounts are stored twice: `amountMinor` is the exact chain base-unit integer as
 * a decimal string (bigint-safe in JSON), `amount` is the human string. All
 * comparisons use `amountMinor`, so 1 USDC and 1 NEAR never get confused.
 */
import type { ActionKind } from './policy.ts';
import type { Verdict } from './audit.ts';

export type Window = 'day' | 'month';

export interface LedgerRecord {
  actionId: string;
  kind: ActionKind;
  /** Asset id as used in the policy. */
  asset: string;
  /** Exact amount in the asset's smallest unit, as a decimal integer string. */
  amountMinor: string;
  /** Human-readable amount, for display only. Never used in arithmetic. */
  amount: string;
  /** Counterparty account id, if the action has one. */
  to: string | null;
  /** Epoch milliseconds when the record was created. */
  at: number;
  status: 'reserved' | 'committed';
  verdict: Verdict;
  /** Epoch milliseconds after which a reservation stops holding budget. */
  expiresAt?: number;
  reason?: string;
}

export interface LedgerView {
  /** Current time in epoch milliseconds. */
  readonly now: number;
  spent(assetId: string, window: Window): bigint;
  reserved(assetId: string, window: Window): bigint;
  /** Number of committed records at or after `since`. */
  txCountSince(since: number): number;
  lastSpendAt(): number | null;
  /** True when this action id was already evaluated and recorded. */
  hasAttempted(actionId: string): boolean;
  /** True when the account has been paid successfully before. */
  isKnownCounterparty(account: string): boolean;
  attemptsByAccount(account: string): number;
}

export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function utcMonthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface FeralLedgerSnapshot {
  agents: Record<string, LedgerRecord[]>;
  aggregate: LedgerRecord[];
}

/**
 * Multi-agent ledger: one spend book per agent plus one vault-wide book.
 *
 * Per-agent limits read the agent's own book; aggregate limits read the vault
 * book. Reservations are kept in both, so a pending approval cannot be spent
 * twice by the same agent or by a sibling agent.
 */
export class FeralLedger {
  readonly now: number;
  private agents: Map<string, SpendLedger>;
  private aggregate: SpendLedger;

  constructor(
    agents: Map<string, SpendLedger> = new Map(),
    aggregate?: SpendLedger,
    now: number = Date.now(),
  ) {
    this.agents = agents;
    this.aggregate = aggregate ?? new SpendLedger([], now);
    this.now = now;
  }

  withClock(now: number): FeralLedger {
    const agents = new Map<string, SpendLedger>();
    for (const [account, ledger] of this.agents) agents.set(account, ledger.withClock(now));
    return new FeralLedger(agents, this.aggregate.withClock(now), now);
  }

  /** The ledger for one agent, created on first use. */
  agent(account: string): SpendLedger {
    let ledger = this.agents.get(account);
    if (!ledger) {
      ledger = new SpendLedger([], this.now);
      this.agents.set(account, ledger);
    }
    return ledger;
  }

  /**
   * A view scoped to one agent, for the per-agent checks in `evaluate`.
   * `excludeActionId` hides one record: policy simulation replays an action that
   * is already in the ledger, and that record must not look like a replay or a
   * zero-second gap to itself.
   */
  viewFor(account: string, excludeActionId?: string): LedgerView {
    const ledger = this.agent(account).excluding(excludeActionId);
    const self = this;
    return {
      now: this.now,
      spent: (assetId, window) => ledger.spent(assetId, window),
      reserved: (assetId, window) => ledger.reserved(assetId, window),
      txCountSince: (since) => ledger.txCountSince(since),
      lastSpendAt: () => ledger.lastSpendAt(),
      hasAttempted: (actionId) => actionId !== excludeActionId && self.hasAttempted(actionId),
      isKnownCounterparty: (account2) => ledger.isKnownCounterparty(account2),
      attemptsByAccount: (account2) => ledger.attemptsByAccount(account2),
    };
  }

  hasAttempted(actionId: string): boolean {
    if (this.aggregate.hasAttempted(actionId)) return true;
    for (const ledger of this.agents.values()) if (ledger.hasAttempted(actionId)) return true;
    return false;
  }

  aggregateSpent(assetId: string, window: Window): bigint {
    return this.aggregate.spent(assetId, window);
  }

  aggregateReserved(assetId: string, window: Window): bigint {
    return this.aggregate.reserved(assetId, window);
  }

  record(account: string, record: LedgerRecord): void {
    this.agent(account).record(record);
    this.aggregate.record({ ...record });
  }

  reserve(account: string, record: Omit<LedgerRecord, 'status'>): void {
    this.agent(account).reserve(record);
    this.aggregate.reserve({ ...record });
  }

  commit(account: string, actionId: string): void {
    this.agent(account).commit(actionId);
    this.aggregate.commit(actionId);
  }

  /** Remove a reservation (rejection, expiry, or a re-check that released it). */
  release(account: string, actionId: string): void {
    for (const ledger of [this.agent(account), this.aggregate]) {
      const records = ledger.all() as LedgerRecord[];
      const index = records.findIndex((r) => r.actionId === actionId && r.status === 'reserved');
      if (index >= 0) records.splice(index, 1);
    }
  }

  all(account?: string): readonly LedgerRecord[] {
    return account === undefined ? this.aggregate.all() : this.agent(account).all();
  }

  /** Every action ever booked or reserved, for dashboards and simulation. */
  history(): LedgerRecord[] {
    return this.aggregate.toJSON();
  }

  pruneExpired(): number {
    let removed = this.aggregate.pruneExpired();
    for (const ledger of this.agents.values()) removed += ledger.pruneExpired();
    return removed;
  }

  toJSON(): FeralLedgerSnapshot {
    const agents: Record<string, LedgerRecord[]> = {};
    for (const [account, ledger] of this.agents) agents[account] = ledger.toJSON();
    return { agents, aggregate: this.aggregate.toJSON() };
  }

  static fromJSON(raw: unknown, now: number = Date.now()): FeralLedger {
    const snapshot = (raw ?? {}) as Partial<FeralLedgerSnapshot>;
    const agents = new Map<string, SpendLedger>();
    for (const [account, records] of Object.entries(snapshot.agents ?? {})) {
      agents.set(account, SpendLedger.fromJSON(records, now));
    }
    return new FeralLedger(agents, SpendLedger.fromJSON(snapshot.aggregate ?? [], now), now);
  }
}

export class SpendLedger implements LedgerView {
  readonly now: number;
  private records: LedgerRecord[];

  constructor(records: LedgerRecord[] = [], now: number = Date.now()) {
    this.records = records;
    this.now = now;
  }

  withClock(now: number): SpendLedger {
    return new SpendLedger(this.records, now);
  }

  /** The same ledger without one action's record, for replaying that action. */
  excluding(actionId?: string): SpendLedger {
    if (!actionId) return this;
    return new SpendLedger(this.records.filter((record) => record.actionId !== actionId), this.now);
  }

  all(): readonly LedgerRecord[] {
    return this.records;
  }

  private active(record: LedgerRecord): boolean {
    // A ledger view is a view at a point in time: records written after `now`
    // must not be visible. Without this, replaying history at its own timestamp
    // sees today's spend and every simulated decision comes back denied.
    if (record.at > this.now) return false;
    if (record.status === 'committed') return true;
    if (record.expiresAt === undefined) return true;
    return record.expiresAt > this.now;
  }

  private inWindow(record: LedgerRecord, window: Window): boolean {
    const recordKey = window === 'day' ? utcDayKey(record.at) : utcMonthKey(record.at);
    const nowKey = window === 'day' ? utcDayKey(this.now) : utcMonthKey(this.now);
    return recordKey === nowKey;
  }

  private sum(assetId: string, window: Window, status: LedgerRecord['status']): bigint {
    let total = 0n;
    for (const record of this.records) {
      if (record.asset !== assetId) continue;
      if (record.status !== status) continue;
      if (!this.active(record)) continue;
      if (!this.inWindow(record, window)) continue;
      total += BigInt(record.amountMinor);
    }
    return total;
  }

  spent(assetId: string, window: Window): bigint {
    return this.sum(assetId, window, 'committed');
  }

  reserved(assetId: string, window: Window): bigint {
    return this.sum(assetId, window, 'reserved');
  }

  txCountSince(since: number): number {
    return this.records.filter((r) => r.at >= since && r.at <= this.now && r.status === 'committed').length;
  }

  lastSpendAt(): number | null {
    const times = this.records.filter((r) => r.at <= this.now && r.status === 'committed').map((r) => r.at);
    return times.length === 0 ? null : Math.max(...times);
  }

  hasAttempted(actionId: string): boolean {
    return this.records.some((r) => r.actionId === actionId && r.at <= this.now);
  }

  isKnownCounterparty(account: string): boolean {
    return this.records.some((r) => r.to === account && r.at <= this.now && r.status === 'committed' && r.verdict === 'allow');
  }

  attemptsByAccount(account: string): number {
    return this.records.filter((r) => r.to === account && r.at <= this.now).length;
  }

  reserve(record: Omit<LedgerRecord, 'status'>): void {
    this.records.push({ ...record, status: 'reserved' });
  }

  commit(actionId: string): void {
    for (const record of this.records) {
      if (record.actionId === actionId) {
        record.status = 'committed';
        // A human said yes: the spend counts as allowed from now on, which is
        // what makes the counterparty "known" for later risk checks.
        record.verdict = 'allow';
        delete record.expiresAt;
      }
    }
  }

  record(record: LedgerRecord): void {
    this.records.push(record);
  }

  /** Drop reservations whose approval window has passed. */
  pruneExpired(): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.status === 'committed' || this.active(r));
    return before - this.records.length;
  }

  toJSON(): LedgerRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  static fromJSON(raw: unknown, now: number = Date.now()): SpendLedger {
    if (!Array.isArray(raw)) return new SpendLedger([], now);
    return new SpendLedger(raw as LedgerRecord[], now);
  }
}
