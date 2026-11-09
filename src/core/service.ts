/**
 * FeralGuard: the stateful product around the pure engine.
 *
 * Responsibilities:
 *  - hold the pinned policy, the per-agent ledgers plus the aggregate ledger, and
 *    the audit chain;
 *  - turn an agent request into a decision, and a decision into a booked spend
 *    (or a reservation plus a human approval request);
 *  - keep reputation, anomaly state and circuit breakers coherent with the
 *    decisions it hands out;
 *  - re-check the policy AND the agent state at execution time, so an approval
 *    issued at 10:00 cannot be used to spend a limit consumed at 10:05 (TOCTOU);
 *  - run the governance surface (timelocks, watcher cancellation, emergency freeze);
 *  - refuse to load a policy whose hash is not the one the owner pinned.
 *
 * Everything is persisted as plain JSON so a judge can read the state by eye.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, type AuditInput, type AuditRecord, type Verdict } from './audit.ts';
import { compilePolicy, loadPolicy, type CompiledPolicy, type PolicyDoc } from './policy.ts';
import { FeralLedger, type FeralLedgerSnapshot, type LedgerRecord, type LedgerView, type Window } from './ledger.ts';
import {
  evaluate,
  DEFAULT_PRICES,
  type ActionRequest,
  type AgentState,
  type AggregateView,
  type Decision,
  type FeralEvaluateContext,
  type SimulationResult,
  type VaultBreakerState,
} from './engine.ts';
import { formatAmount } from './money.ts';
import { hashObject } from './canonical.ts';
import {
  applyAnomaly,
  applyApproval,
  applyCleanSpend,
  applyDenial,
  applyRecovery,
  effectiveLimit,
  isFrozen,
} from './reputation.ts';
import { freshAnomalyState, recordSpend, type AnomalyState } from './anomaly.ts';
import {
  currentLevel,
  limitFraction,
  normalState,
  triggerLevel1,
  triggerLevel3,
  triggerLevel4,
  type BreakerLevel,
  type CircuitBreakerState,
} from './circuit.ts';

export interface ApprovalRequest {
  id: string;
  actionId: string;
  action: ActionRequest;
  decisionId: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'superseded';
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface Attempt {
  actionId: string;
  at: number;
  verdict: Verdict;
  reasonCodes: string[];
}

export interface Timelock {
  id: string;
  actionType: string;
  params: unknown;
  proposedAt: number;
  executesAt: number;
  cancelled: boolean;
  executed: boolean;
  proposedBy: string;
}

export interface AgentRecord {
  state: AgentState;
  lastCleanSpendAt: number;
  registeredAt: number;
}

export interface GuardState {
  version: 2;
  policyHash: string;
  policy: PolicyDoc;
  ledger: FeralLedgerSnapshot;
  audit: AuditRecord[];
  approvals: ApprovalRequest[];
  attempts: Attempt[];
  agents: Record<string, AgentRecord>;
  vaultBreaker: VaultBreakerState;
  timelocks: Timelock[];
}

export interface GuardConfig {
  policyText: string;
  /** Directory used by `save()`. */
  stateDir?: string;
  /** Overridable clock, ms since epoch. */
  clock?: () => number;
  prices?: Record<string, bigint>;
  /** Executor invoked after a decision is allowed. Defaults to a dry run. */
  executor?: (action: ActionRequest, decision: Decision) => Promise<ExecutionResult> | ExecutionResult;
  /** Refuse to load a different policy than this hash. */
  expectedPolicyHash?: string;
}

export interface ExecutionResult {
  status: 'simulated' | 'submitted' | 'failed';
  detail: string;
  ref?: string;
}

export interface EvaluateOptions {
  /** When true, nothing is booked: the decision is informational only. */
  dryRun?: boolean;
}

export interface GuardEvaluateResult {
  decision: Decision;
  execution: ExecutionResult | null;
  approval: ApprovalRequest | null;
}

export interface AgentLimitInput {
  perTx?: Map<string, bigint>;
  daily?: Map<string, bigint>;
  monthly?: Map<string, bigint>;
}

export interface EffectiveLimits {
  reputation: number;
  circuitBreakerLevel: number;
  assets: Record<string, { perTx: string; daily: string; monthly: string }>;
}

export interface BreakerStatus {
  level: number;
  reason: string;
  expiresAt: number;
}

const STATE_FILE = 'state.json';
const DAY_MS = 86_400_000;

/** View over one agent's ledger plus every attempt ever seen, for replay protection. */
class AttemptAwareView implements LedgerView {
  readonly now: number;
  private base: LedgerView;
  private attempts: Attempt[];

  constructor(base: LedgerView, attempts: Attempt[]) {
    this.base = base;
    this.attempts = attempts;
    this.now = base.now;
  }

  spent(assetId: string, window: Window): bigint {
    return this.base.spent(assetId, window);
  }
  reserved(assetId: string, window: Window): bigint {
    return this.base.reserved(assetId, window);
  }
  txCountSince(since: number): number {
    return this.base.txCountSince(since);
  }
  lastSpendAt(): number | null {
    return this.base.lastSpendAt();
  }
  hasAttempted(actionId: string): boolean {
    return this.base.hasAttempted(actionId) || this.attempts.some((a) => a.actionId === actionId);
  }
  isKnownCounterparty(account: string): boolean {
    return this.base.isKnownCounterparty(account);
  }
  attemptsByAccount(account: string): number {
    return this.base.attemptsByAccount(account);
  }
}

function cloneAgent(state: AgentState): AgentState {
  return {
    ...state,
    knownCounterparties: [...state.knownCounterparties],
    anomaly: { ...state.anomaly, flags: [...state.anomaly.flags] },
  };
}

export class FeralGuard {
  private policy: CompiledPolicy;
  private ledger: FeralLedger;
  private audit: AuditLog;
  private approvals: ApprovalRequest[] = [];
  private attempts: Attempt[] = [];
  private agents: Map<string, AgentRecord> = new Map();
  private vaultBreaker: VaultBreakerState = normalState();
  private timelocks: Timelock[] = [];
  private history: { action: ActionRequest; at: number }[] = [];
  private config: GuardConfig;

  private constructor(policy: CompiledPolicy, config: GuardConfig) {
    this.policy = policy;
    this.config = config;
    this.ledger = new FeralLedger(new Map(), undefined, this.now());
    this.audit = new AuditLog();
    this.seedAgents();
  }

  private seedAgents(): void {
    const now = this.now();
    for (const spec of this.policy.agents) {
      if (this.agents.has(spec.account)) continue;
      this.agents.set(spec.account, {
        state: {
          account: spec.account,
          reputation: this.policy.reputation.initial,
          paused: false,
          tier: spec.tier,
          attestationHash: spec.attestationHash ?? '',
          txCount: 0,
          denyCount: 0,
          circuitBreaker: 0,
          cbExpiresAt: 0,
          lastSpendAt: 0,
          knownCounterparties: [],
          anomaly: freshAnomalyState(now),
        },
        lastCleanSpendAt: now,
        registeredAt: now,
      });
    }
  }

  private now(): number {
    return this.config.clock ? this.config.clock() : Date.now();
  }

  /** Replace the clock. Tests and the judge demo use this to make time travel explicit. */
  setClock(clock: () => number): void {
    this.config.clock = clock;
  }

  static create(config: GuardConfig): FeralGuard {
    const { doc } = loadPolicy(config.policyText);
    const compiled = compilePolicy(doc);
    if (config.expectedPolicyHash && config.expectedPolicyHash !== compiled.hash) {
      throw new Error(
        `policy hash mismatch: owner pinned ${config.expectedPolicyHash}, file is ${compiled.hash}. Refusing to load.`,
      );
    }
    return new FeralGuard(compiled, config);
  }

  get policyHash(): string {
    return this.policy.hash;
  }

  get policyDoc(): PolicyDoc {
    return this.policy.doc;
  }

  get compiled(): CompiledPolicy {
    return this.policy;
  }

  get auditLog(): AuditLog {
    return this.audit;
  }

  get pendingApprovals(): ApprovalRequest[] {
    return this.approvals.filter((a) => a.status === 'pending');
  }

  get pendingTimelocks(): Timelock[] {
    return this.timelocks.filter((t) => !t.cancelled && !t.executed);
  }

  get breaker(): VaultBreakerState {
    return { ...this.vaultBreaker };
  }

  private viewFor(account: string): AttemptAwareView {
    return new AttemptAwareView(this.ledger.withClock(this.now()).viewFor(account), this.attempts);
  }

  private aggregateView(at: number = this.now()): AggregateView {
    const spent = new Map<string, bigint>();
    const monthlySpent = new Map<string, bigint>();
    const limits = new Map<string, bigint>();
    // Use the injected clock, never the wall clock: a ledger whose windows are
    // computed at a different time than the decision is a silent bypass.
    const ledger = this.ledger.withClock(at);
    for (const [asset, limit] of this.policy.aggregateLimits.daily) {
      limits.set(asset, limit);
      spent.set(asset, ledger.aggregateSpent(asset, 'day') + ledger.aggregateReserved(asset, 'day'));
    }
    for (const [asset, limit] of this.policy.aggregateLimits.monthly) {
      limits.set(`${asset}:month`, limit);
      monthlySpent.set(asset, ledger.aggregateSpent(asset, 'month') + ledger.aggregateReserved(asset, 'month'));
    }
    return { limits, spent, monthlySpent };
  }  private contextFor(
    action: ActionRequest,
    policy: CompiledPolicy = this.policy,
    at: number = this.now(),
    options: { resetAnomaly?: boolean } = {},
  ): FeralEvaluateContext {
    const record = this.agents.get(action.actor);
    const now = at;
    const breaker = this.effectiveAgentBreaker(record);
    const state = record ? cloneAgent(record.state) : undefined;
    if (state && options.resetAnomaly) state.anomaly = freshAnomalyState(at);

    return {
      now,
      prices: this.config.prices ?? DEFAULT_PRICES,
      agentState: state ? { ...state, circuitBreaker: breaker.level, cbExpiresAt: breaker.expiresAt } : undefined,
      vaultBreaker: this.vaultBreaker,
      aggregateView: this.aggregateView(at),
      attestationProof: action.attestationProof,
    };
  }

  private effectiveAgentBreaker(record: AgentRecord | undefined): CircuitBreakerState {
    if (!record) return normalState();
    const state: CircuitBreakerState = {
      level: record.state.circuitBreaker as BreakerLevel,
      triggeredAt: 0,
      expiresAt: record.state.cbExpiresAt,
      reason: '',
    };
    if (currentLevel(state, this.now()) === 0 && record.state.circuitBreaker !== 0) {
      record.state.circuitBreaker = 0;
      record.state.cbExpiresAt = 0;
    }
    return state;
  }

  /** Dry-run an action without touching ledger, audit, approvals or agent state. */
  preview(action: ActionRequest): Decision {
    const policy = this.policy;
    return evaluate(policy, action, this.viewFor(action.actor), this.contextFor(action, policy));
  }

  /** Evaluate and, when allowed, execute. When approval is needed, reserve and queue. */
  async submit(action: ActionRequest, options: EvaluateOptions = {}): Promise<GuardEvaluateResult> {
    const now = this.now();
    const record = this.agents.get(action.actor);
    const policy = this.policy;
    const decision = evaluate(policy, action, this.viewFor(action.actor), this.contextFor(action, policy));

    if (options.dryRun) {
      return { decision, execution: null, approval: null };
    }

    this.attempts.push({
      actionId: action.id,
      at: now,
      verdict: decision.verdict,
      reasonCodes: decision.reasons.map((r) => r.code),
    });
    this.history.push({ action, at: now });

    if (!record) {
      this.auditFor(action, decision, 'deny', 0, 0, null);
      return { decision, execution: null, approval: null };
    }

    const reputationBefore = record.state.reputation;
    const codes = decision.reasons.map((r) => r.code as string);

    if (decision.verdict === 'deny') {
      record.state.reputation = applyDenial(reputationBefore, policy.reputation);
      record.state.denyCount += 1;
      this.noteDeniedAnomaly(record, codes, now);
      this.auditFor(action, decision, 'deny', reputationBefore, record.state.reputation, record.state);
      return { decision, execution: null, approval: null };
    }

    if (decision.verdict === 'require_approval') {
      const approval = this.enqueueApproval(action, decision);
      this.auditFor(action, decision, 'require_approval', reputationBefore, record.state.reputation, record.state);
      return { decision, execution: null, approval };
    }

    // Allowed: only now, after the executor has actually run, do we say so.
    const execution = await this.execute(action, decision);
    if (execution.status === 'failed') {
      record.state.reputation = applyDenial(reputationBefore, policy.reputation);
      record.state.denyCount += 1;
      this.auditFor(
        action,
        { ...decision, verdict: 'deny', reasons: [...decision.reasons, { code: 'EXECUTION_FAILED', severity: 'deny', message: execution.detail }] },
        'deny',
        reputationBefore,
        record.state.reputation,
        record.state,
      );
      return {
        decision: {
          ...decision,
          verdict: 'deny',
          reasons: [...decision.reasons, { code: 'EXECUTION_FAILED', severity: 'deny', message: execution.detail }],
        },
        execution,
        approval: null,
      };
    }

    this.writeLedger(record, action, decision, now);
    this.applyAllowAccounting(record, action, decision, now);
    this.auditFor(action, decision, 'allow', reputationBefore, record.state.reputation, record.state);
    return { decision, execution, approval: null };
  }

  private enqueueApproval(action: ActionRequest, decision: Decision): ApprovalRequest {
    const now = this.now();
    const ttl = this.policy.approval.ttlSeconds;
    const approval: ApprovalRequest = {
      id: `apr_${hashObject({ actionId: action.id, at: now }).slice(0, 12)}`,
      actionId: action.id,
      action,
      decisionId: decision.decisionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
      status: 'pending',
    };
    this.approvals.push(approval);
    this.ledger.reserve(action.actor, {
      actionId: action.id,
      kind: action.kind,
      asset: action.asset,
      amountMinor: decision.amountMinor ?? '0',
      amount: decision.amount,
      to: action.to ?? null,
      at: now,
      verdict: decision.verdict,
      expiresAt: now + ttl * 1000,
      reason: 'awaiting human approval',
    });
    return approval;
  }

  private writeLedger(record: AgentRecord, action: ActionRequest, decision: Decision, now: number): void {
    this.ledger.record(action.actor, {
      actionId: action.id,
      kind: action.kind,
      asset: action.asset,
      amountMinor: decision.amountMinor ?? '0',
      amount: decision.amount,
      to: action.to ?? null,
      at: now,
      status: 'committed',
      verdict: 'allow',
    });
    void record;
  }

  /** Update reputation, anomaly state, counters and counterparties for an allowed spend. */
  private applyAllowAccounting(record: AgentRecord, action: ActionRequest, decision: Decision, now: number): void {
    const config = this.policy.reputation;
    const state = record.state;
    const recovered = now - record.lastCleanSpendAt >= config.recoveryWindowDays * DAY_MS;
    if (recovered && state.reputation < 100) {
      state.reputation = applyRecovery(state.reputation, config);
    } else {
      state.reputation = applyCleanSpend(state.reputation, config);
    }
    state.txCount += 1;
    state.lastSpendAt = now;
    record.lastCleanSpendAt = now;
    if (action.to && !state.knownCounterparties.includes(action.to)) state.knownCounterparties.push(action.to);

    const amountMinor = BigInt(decision.amountMinor ?? '0');
    const beforeFlags = new Set(state.anomaly.flags);
    const next: AnomalyState = recordSpend(state.anomaly, amountMinor, action.to ?? '', now, this.policy.anomaly);

    const dailyLimit = this.policy.agentLimits.get(action.actor)?.daily.get(action.asset) ?? 0n;
    const threshold = (dailyLimit * BigInt(this.policy.anomaly.drainageThresholdBps)) / 10_000n;
    if (next.drainageTxCount >= 2 && next.drainageAmount > threshold && !next.flags.includes('DRAINAGE')) {
      next.flags.push('DRAINAGE');
    }
    if (next.burstCount >= this.policy.anomaly.burstThreshold && !next.flags.includes('BURST')) {
      next.flags.push('BURST');
    }
    const newFlags = next.flags.filter((f) => !beforeFlags.has(f));
    if (newFlags.length > 0) {
      const points = newFlags.includes('BURST') ? 30 : 25;
      next.anomalyScore = Math.min(100, next.anomalyScore + points);
      if (state.reputation > 0) state.reputation = applyAnomaly(state.reputation, config);
    }
    state.anomaly = next;

    if (newFlags.includes('BURST') && this.policy.anomaly.autoEscalate && state.circuitBreaker === 0) {
      const breaker = triggerLevel1(normalState(), 'burst anomaly detected', this.policy.circuitBreakers.level1Duration * 1000, now);
      state.circuitBreaker = breaker.level;
      state.cbExpiresAt = breaker.expiresAt;
    }
  }

  /** Record a denied attempt in the anomaly state so a burst escalates even when denied. */
  private noteDeniedAnomaly(record: AgentRecord, codes: string[], now: number): void {
    const state = record.state;
    const anomaly = state.anomaly;
    const newFlags: string[] = [];

    if (codes.includes('ANOMALY_BURST')) {
      if (anomaly.burstWindowStart === 0 || now - anomaly.burstWindowStart > this.policy.anomaly.burstWindowMs) {
        anomaly.burstWindowStart = now;
        anomaly.burstCount = 1;
      } else {
        anomaly.burstCount += 1;
      }
      if (!anomaly.flags.includes('BURST')) {
        anomaly.flags.push('BURST');
        newFlags.push('BURST');
      }
      if (this.policy.anomaly.autoEscalate && state.circuitBreaker === 0) {
        const breaker = triggerLevel1(normalState(), 'burst anomaly detected', this.policy.circuitBreakers.level1Duration * 1000, now);
        state.circuitBreaker = breaker.level;
        state.cbExpiresAt = breaker.expiresAt;
      }
    }
    for (const [code, flag] of [['ANOMALY_DRAINAGE', 'DRAINAGE'], ['ANOMALY_DEVIATION', 'DEVIATION']] as const) {
      if (codes.includes(code) && !anomaly.flags.includes(flag)) {
        anomaly.flags.push(flag);
        newFlags.push(flag);
      }
    }
    if (newFlags.length > 0) {
      anomaly.anomalyScore = Math.min(100, anomaly.anomalyScore + 25);
      state.reputation = applyAnomaly(state.reputation, this.policy.reputation);
    }
  }

  private auditFor(
    action: ActionRequest,
    decision: Decision,
    verdict: Verdict,
    reputationBefore: number,
    reputationAfter: number,
    state: AgentState | null,
  ): void {
    const input: AuditInput = {
      at: decision.evaluatedAt,
      actor: action.actor,
      agent: action.actor,
      actionId: action.id,
      kind: action.kind,
      asset: action.asset,
      amount: decision.amount,
      to: action.to ?? null,
      verdict,
      reasons: decision.reasons.map((r) => r.code),
      riskScore: decision.risk.score,
      policyHash: this.policy.hash,
      reputationBefore,
      reputationAfter,
      anomalyScore: state ? state.anomaly.anomalyScore : 0,
      circuitBreakerLevel: state ? state.circuitBreaker : this.vaultBreaker.level,
      payloadHash: hashObject(action),
    };
    this.audit.append(input);
  }

  /**
   * Replace the policy at runtime (the owner edits policy.yaml and reloads).
   * Pending approvals are re-checked against the new policy at approval time.
   */
  updatePolicy(policyText: string, options: { expectedCurrentHash?: string } = {}): { previousHash: string; policyHash: string } {
    if (options.expectedCurrentHash && options.expectedCurrentHash !== this.policy.hash) {
      throw new Error(`policy hash mismatch: pinned ${options.expectedCurrentHash}, current ${this.policy.hash}`);
    }
    const { doc } = loadPolicy(policyText);
    const compiled = compilePolicy(doc);
    const previousHash = this.policy.hash;
    this.policy = compiled;
    this.seedAgents();
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor: doc.owner,
      agent: doc.owner,
      actionId: `policy_${compiled.hash.slice(0, 12)}`,
      kind: 'policy.update',
      asset: '-',
      amount: '0',
      to: null,
      verdict: 'allow',
      reasons: ['POLICY_UPDATED'],
      riskScore: 0,
      policyHash: compiled.hash,
      reputationBefore: 0,
      reputationAfter: 0,
      anomalyScore: 0,
      circuitBreakerLevel: this.vaultBreaker.level,
      payloadHash: hashObject({ previousHash, policyHash: compiled.hash, doc }),
    });
    return { previousHash, policyHash: compiled.hash };
  }

  /** Human approves: the policy and the agent state are re-checked before anything is booked. */
  async approve(approvalId: string, approver: string): Promise<{ status: string; decision?: Decision; execution?: ExecutionResult }> {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) return { status: 'not_found' };
    if (!this.policy.approval.approvers.includes(approver)) return { status: 'not_an_approver' };
    if (approval.status !== 'pending') return { status: `already_${approval.status}` };

    const now = this.now();
    if (Date.parse(approval.expiresAt) < now) {
      approval.status = 'expired';
      this.release(approval);
      this.auditDecision(approval, 'deny', approver, 'APPROVAL_EXPIRED');
      return { status: 'expired' };
    }

    // Release the reservation so the re-check sees the budget as it is now.
    this.release(approval.actionId);

    // The request was already recorded when it was queued, so the replay guard
    // must not feral the legitimate re-check of that very request.
    const priorAttempt = this.takeAttempt(approval.actionId);
    const record = this.agents.get(approval.action.actor);
    const decision = evaluate(
      this.policy,
      approval.action,
      this.viewFor(approval.action.actor),
      this.contextFor(approval.action),
    );
    if (decision.verdict === 'deny' || !record) {
      this.restoreAttempt(priorAttempt);
      approval.status = 'superseded';
      approval.decidedBy = approver;
      approval.decidedAt = new Date(now).toISOString();
      approval.note = `re-check failed: ${decision.reasons.map((r) => r.code).join(', ')}`;
      this.auditDecision(approval, 'deny', approver, 'APPROVAL_RECHECK_FAILED');
      return { status: 'recheck_failed', decision };
    }

    // Reputation may have fallen below the freeze threshold since the request.
    if (isFrozen(record.state.reputation, this.policy.reputation)) {
      this.restoreAttempt(priorAttempt);
      approval.status = 'superseded';
      approval.note = 'REPUTATION_FROZEN';
      this.auditDecision(approval, 'deny', approver, 'REPUTATION_FROZEN');
      return { status: 'frozen', decision };
    }

    const execution = await this.execute(approval.action, decision);
    if (execution.status === 'failed') {
      this.restoreAttempt(priorAttempt);
      approval.status = 'superseded';
      approval.note = execution.detail;
      this.auditDecision(approval, 'deny', approver, 'EXECUTION_FAILED');
      return { status: 'execution_failed', decision, execution };
    }

    approval.status = 'executed';
    approval.decidedBy = approver;
    approval.decidedAt = new Date(now).toISOString();

    const reputationBefore = record.state.reputation;
    record.state.reputation = applyApproval(reputationBefore, this.policy.reputation);
    this.applyAllowAccounting(record, approval.action, decision, now);
    this.ledger.record(approval.action.actor, {
      actionId: approval.actionId,
      kind: approval.action.kind,
      asset: approval.action.asset,
      amountMinor: decision.amountMinor ?? '0',
      amount: decision.amount,
      to: approval.action.to ?? null,
      at: now,
      status: 'committed',
      verdict: 'allow',
    });
    this.attempts.push({
      actionId: approval.actionId,
      at: now,
      verdict: 'allow',
      reasonCodes: decision.reasons.map((r) => r.code),
    });
    this.auditDecision(approval, 'allow', approver, 'APPROVED_AND_EXECUTED', reputationBefore, record.state);
    return { status: 'executed', decision, execution };
  }

  private takeAttempt(actionId: string): Attempt | null {
    const index = this.attempts.findIndex((a) => a.actionId === actionId);
    if (index < 0) return null;
    return this.attempts.splice(index, 1)[0];
  }

  private restoreAttempt(attempt: Attempt | null): void {
    if (attempt) this.attempts.push(attempt);
  }

  reject(approvalId: string, approver: string, note?: string): { status: string } {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) return { status: 'not_found' };
    if (!this.policy.approval.approvers.includes(approver)) return { status: 'not_an_approver' };
    if (approval.status !== 'pending') return { status: `already_${approval.status}` };
    approval.status = 'rejected';
    approval.decidedBy = approver;
    approval.decidedAt = new Date(this.now()).toISOString();
    approval.note = note;
    this.release(approval.actionId);
    this.auditDecision(approval, 'deny', approver, 'REJECTED_BY_HUMAN');
    return { status: 'rejected' };
  }

  private release(actionId: string): void {
    for (const account of this.agents.keys()) this.ledger.release(account, actionId);
  }

  private auditDecision(
    approval: ApprovalRequest,
    verdict: Verdict,
    actor: string,
    code: string,
    reputationBefore = 0,
    state: AgentState | null = null,
  ): void {
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor,
      agent: approval.action.actor,
      actionId: approval.actionId,
      kind: approval.action.kind,
      asset: approval.action.asset,
      amount: approval.action.amount,
      to: approval.action.to ?? null,
      verdict,
      reasons: [code],
      riskScore: 0,
      policyHash: this.policy.hash,
      reputationBefore,
      reputationAfter: state ? state.reputation : reputationBefore,
      anomalyScore: state ? state.anomaly.anomalyScore : 0,
      circuitBreakerLevel: state ? state.circuitBreaker : this.vaultBreaker.level,
      payloadHash: hashObject(approval.action),
    });
  }

  private async execute(action: ActionRequest, decision: Decision): Promise<ExecutionResult> {
    if (!this.config.executor) {
      return { status: 'simulated', detail: 'no executor configured; spend booked locally' };
    }
    try {
      return await this.config.executor(action, decision);
    } catch (err) {
      return { status: 'failed', detail: (err as Error).message };
    }
  }

  // -- multi-agent -----------------------------------------------------------

  registerAgent(account: string, tier: string, limits: AgentLimitInput = {}): AgentState {
    if (this.agents.has(account)) throw new Error(`agent ${account} already exists`);
    const now = this.now();
    const record: AgentRecord = {
      state: {
        account,
        reputation: this.policy.reputation.initial,
        paused: false,
        tier,
        attestationHash: '',
        txCount: 0,
        denyCount: 0,
        circuitBreaker: 0,
        cbExpiresAt: 0,
        lastSpendAt: 0,
        knownCounterparties: [],
        anomaly: freshAnomalyState(now),
      },
      lastCleanSpendAt: now,
      registeredAt: now,
    };
    this.agents.set(account, record);
    this.policy.agentLimits.set(account, {
      perTx: limits.perTx ?? new Map(),
      daily: limits.daily ?? new Map(),
      monthly: limits.monthly ?? new Map(),
    });
    this.policy.agents.push({ account, tier: tier === 'supervisor' ? 'supervisor' : 'worker', limits: {} });
    return cloneAgent(record.state);
  }

  removeAgent(account: string): boolean {
    this.policy.agentLimits.delete(account);
    this.policy.agents = this.policy.agents.filter((a) => a.account !== account);
    return this.agents.delete(account);
  }

  pauseAgent(account: string): void {
    const record = this.agents.get(account);
    if (!record) throw new Error(`agent ${account} not found`);
    record.state.paused = true;
  }

  unpauseAgent(account: string): void {
    const record = this.agents.get(account);
    if (!record) throw new Error(`agent ${account} not found`);
    record.state.paused = false;
    record.state.circuitBreaker = 0;
    record.state.cbExpiresAt = 0;
  }

  getAgents(): AgentState[] {
    return [...this.agents.values()].map((r) => cloneAgent(r.state));
  }

  getAgent(account: string): AgentState | null {
    const record = this.agents.get(account);
    return record ? cloneAgent(record.state) : null;
  }

  getReputation(account: string): number {
    return this.agents.get(account)?.state.reputation ?? 0;
  }

  getEffectiveLimits(account: string): EffectiveLimits {
    const record = this.agents.get(account);
    const limits = this.policy.agentLimits.get(account) ?? this.policy.limits;
    const fraction = record ? limitFraction(this.effectiveAgentBreaker(record), this.now()) : 1;
    const reputation = record?.state.reputation ?? 0;
    const assets: EffectiveLimits['assets'] = {};
    const ids = new Set<string>([...limits.perTx.keys(), ...limits.daily.keys(), ...limits.monthly.keys()]);
    for (const id of ids) {
      const asset = this.policy.assets.get(id);
      const scale = (value: bigint | undefined): bigint => {
        if (value === undefined) return 0n;
        const afterRep = effectiveLimit(value, reputation);
        return fraction === 1 ? afterRep : (afterRep * BigInt(Math.round(fraction * 10_000))) / 10_000n;
      };
      assets[id] = {
        perTx: formatAmount(scale(limits.perTx.get(id)), asset?.decimals ?? 0),
        daily: formatAmount(scale(limits.daily.get(id)), asset?.decimals ?? 0),
        monthly: formatAmount(scale(limits.monthly.get(id)), asset?.decimals ?? 0),
      };
    }
    return {
      reputation,
      circuitBreakerLevel: record ? currentLevel(this.effectiveAgentBreaker(record), this.now()) : 0,
      assets,
    };
  }

  // -- anomaly ---------------------------------------------------------------

  getAnomalyScore(account: string): number {
    return this.agents.get(account)?.state.anomaly.anomalyScore ?? 0;
  }

  getAnomalyFlags(account: string): string[] {
    return [...(this.agents.get(account)?.state.anomaly.flags ?? [])];
  }

  /** Feed for the dashboard: one row per agent with an active flag. */
  anomalyFeed(): { at: string; agent: string; flags: string[]; score: number; severity: 'low' | 'medium' | 'high' }[] {
    return [...this.agents.values()]
      .filter((r) => r.state.anomaly.flags.length > 0)
      .map((r) => ({
        at: new Date(this.now()).toISOString(),
        agent: r.state.account,
        flags: [...r.state.anomaly.flags],
        score: r.state.anomaly.anomalyScore,
        severity: r.state.anomaly.anomalyScore >= 70 ? 'high' : r.state.anomaly.anomalyScore >= 30 ? 'medium' : 'low',
      }));
  }

  // -- circuit breakers ------------------------------------------------------

  getCircuitBreakerLevel(account?: string): BreakerStatus {
    if (account === undefined) {
      const level = currentLevel(this.vaultBreaker, this.now());
      return { level, reason: this.vaultBreaker.reason, expiresAt: this.vaultBreaker.expiresAt };
    }
    const record = this.agents.get(account);
    if (!record) return { level: 0, reason: '', expiresAt: 0 };
    const level = currentLevel(this.effectiveAgentBreaker(record), this.now());
    return {
      level,
      reason: level > 0 ? (record.state.circuitBreaker === 1 ? 'limits reduced after an anomaly' : 'agent paused by the circuit breaker') : '',
      expiresAt: record.state.cbExpiresAt,
    };
  }

  triggerCircuitBreaker(account: string, level: number, reason: string): void {
    const record = this.agents.get(account);
    if (!record) throw new Error(`agent ${account} not found`);
    const now = this.now();
    record.state.circuitBreaker = Math.max(0, Math.min(4, Math.trunc(level)));
    record.state.cbExpiresAt = record.state.circuitBreaker === 1 ? now + this.policy.circuitBreakers.level1Duration * 1000 : 0;
    if (record.state.circuitBreaker === 0) record.state.cbExpiresAt = 0;
    this.audit.append({
      at: new Date(now).toISOString(),
      actor: this.policy.doc.owner,
      agent: account,
      actionId: `cb_${account}_${now}`,
      kind: 'circuit.breaker',
      asset: '-',
      amount: '0',
      to: null,
      verdict: 'allow',
      reasons: ['CIRCUIT_BREAKER_TRIGGERED'],
      riskScore: 0,
      policyHash: this.policy.hash,
      reputationBefore: record.state.reputation,
      reputationAfter: record.state.reputation,
      anomalyScore: record.state.anomaly.anomalyScore,
      circuitBreakerLevel: record.state.circuitBreaker,
      payloadHash: hashObject({ account, level, reason }),
    });
  }

  // -- governance ------------------------------------------------------------

  proposeTimelock(actionType: string, params: unknown): string {
    const now = this.now();
    const id = `tl_${this.timelocks.length}`;
    this.timelocks.push({
      id,
      actionType,
      params,
      proposedAt: now,
      executesAt: now + this.policy.governance.timelockDelay * 1000,
      cancelled: false,
      executed: false,
      proposedBy: this.policy.doc.owner,
    });
    return id;
  }

  cancelTimelock(id: string, actor?: string): void {
    const tl = this.timelocks.find((t) => t.id === id);
    if (!tl) throw new Error(`timelock ${id} not found`);
    const caller = actor ?? this.policy.doc.owner;
    const isOwner = caller === this.policy.doc.owner;
    const isMultisig = this.policy.multisig.threshold > 0 && this.policy.multisig.members.includes(caller);
    const isWatcher = this.policy.governance.watcherCanCancel && this.policy.watchers.includes(caller);
    if (!isOwner && !isMultisig && !isWatcher) {
      throw new Error(`${caller} is not owner, multisig or watcher; cannot cancel timelock`);
    }
    if (tl.cancelled) throw new Error(`timelock ${id} is already cancelled`);
    if (tl.executed) throw new Error(`timelock ${id} is already executed`);
    tl.cancelled = true;
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor: caller,
      agent: caller,
      actionId: id,
      kind: 'governance.cancel',
      asset: '-',
      amount: '0',
      to: null,
      verdict: 'deny',
      reasons: ['TIMELOCK_CANCELLED'],
      riskScore: 0,
      policyHash: this.policy.hash,
      reputationBefore: 0,
      reputationAfter: 0,
      anomalyScore: 0,
      circuitBreakerLevel: this.vaultBreaker.level,
      payloadHash: hashObject({ id, actionType: tl.actionType, cancelledBy: caller }),
    });
  }

  executeTimelock(id: string, actor?: string): void {
    const tl = this.timelocks.find((t) => t.id === id);
    if (!tl) throw new Error(`timelock ${id} not found`);
    const caller = actor ?? this.policy.doc.owner;
    const isOwner = caller === this.policy.doc.owner;
    const isMultisig = this.policy.multisig.threshold > 0 && this.policy.multisig.members.includes(caller);
    if (!isOwner && !isMultisig) throw new Error(`${caller} is not owner or multisig; cannot execute timelock`);
    if (tl.cancelled) throw new Error(`timelock ${id} was cancelled`);
    if (tl.executed) throw new Error(`timelock ${id} is already executed`);
    if (this.now() < tl.executesAt) throw new Error(`timelock ${id} is not yet executable until ${new Date(tl.executesAt).toISOString()}`);
    tl.executed = true;
    if (tl.actionType === 'thaw') this.vaultBreaker = normalState();
  }

  emergencyFreeze(actor?: string): void {
    const caller = actor ?? this.policy.doc.owner;
    if (!this.policy.guardians.includes(caller)) {
      throw new Error(`${caller} is not a guardian; cannot emergency freeze`);
    }
    this.vaultBreaker = triggerLevel4(this.vaultBreaker, `emergency freeze by ${caller}`, this.now());
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor: caller,
      agent: caller,
      actionId: `freeze_${this.now()}`,
      kind: 'governance.freeze',
      asset: '-',
      amount: '0',
      to: null,
      verdict: 'allow',
      reasons: ['EMERGENCY_FREEZE'],
      riskScore: 0,
      policyHash: this.policy.hash,
      reputationBefore: 0,
      reputationAfter: 0,
      anomalyScore: 0,
      circuitBreakerLevel: 4,
      payloadHash: hashObject({ frozenBy: caller, at: this.now() }),
    });
  }

  pauseVault(reason = 'paused by governance'): void {
    this.vaultBreaker = triggerLevel3(this.vaultBreaker, reason, this.now());
  }

  thaw(actor?: string): void {
    const caller = actor ?? this.policy.doc.owner;
    const isOwner = caller === this.policy.doc.owner;
    const isMultisig = this.policy.multisig.threshold > 0 && this.policy.multisig.members.includes(caller);
    if (!isOwner && !isMultisig) throw new Error(`${caller} is not owner or multisig; cannot thaw`);
    this.vaultBreaker = normalState();
  }

  registerWatcher(account: string): void {
    if (!this.policy.watchers.includes(account)) this.policy.watchers.push(account);
    if (!this.policy.doc.watchers) this.policy.doc.watchers = [];
    if (!this.policy.doc.watchers.includes(account)) this.policy.doc.watchers.push(account);
  }

  registerGuardian(account: string): void {
    if (!this.policy.guardians.includes(account)) this.policy.guardians.push(account);
    if (!this.policy.doc.guardians) this.policy.doc.guardians = [];
    if (!this.policy.doc.guardians.includes(account)) this.policy.doc.guardians.push(account);
  }

  // -- aggregate -------------------------------------------------------------

  getAggregateSpent(asset: string, window: Window): bigint {
    // Read at the current clock. The stored ledger keeps its creation time, and a
    // record booked after that time is a future record to it, so querying the raw
    // ledger would silently report zero for spends made since startup.
    return this.ledger.withClock(this.now()).aggregateSpent(asset, window);
  }

  getAggregateReserved(asset: string, window: Window): bigint {
    return this.ledger.withClock(this.now()).aggregateReserved(asset, window);
  }

  getAggregateRemaining(asset: string, window: Window): bigint {
    const limit = window === 'day' ? this.policy.aggregateLimits.daily.get(asset) : this.policy.aggregateLimits.monthly.get(asset);
    if (limit === undefined) return 0n;
    const ledger = this.ledger.withClock(this.now());
    const used = ledger.aggregateSpent(asset, window) + ledger.aggregateReserved(asset, window);
    return limit - used > 0n ? limit - used : 0n;
  }

  // -- simulation ------------------------------------------------------------

  simulatePolicy(proposedPolicyText: string): SimulationResult {
    const proposed = compilePolicy(loadPolicy(proposedPolicyText).doc);
    const diffs: SimulationResult['diffs'] = [];
    for (const entry of this.history) {
      const action = entry.action;
      // Replay at the moment the action was submitted. Using the current clock
      // would make every historical action look simultaneous, so the minimum
      // interval would deny them all and hide the real policy diff. Attempts are
      // deliberately not consulted: this is a replay, not a second submission.
      const view = this.ledger.withClock(entry.at).viewFor(action.actor, action.id);
      // Anomaly state is current, not historical; resetting it keeps today's flags
      // from deciding yesterday's action. Reputation and limits are compared.
      const before = evaluate(this.policy, action, view, this.contextFor(action, this.policy, entry.at, { resetAnomaly: true }));
      const after = evaluate(proposed, action, view, this.contextFor(action, proposed, entry.at, { resetAnomaly: true }));
      if (before.verdict !== after.verdict) {
        diffs.push({
          actionId: action.id,
          oldVerdict: before.verdict,
          newVerdict: after.verdict,
          oldReasons: before.reasons.map((r) => r.code),
          newReasons: after.reasons.map((r) => r.code),
        });
      }
    }
    return { diffs, totalActions: this.history.length, changedCount: diffs.length };
  }

  // -- reporting -------------------------------------------------------------

  /** Human-readable per-asset summary for the primary agent. */
  summary(): { asset: string; perTx: string | null; daily: { limit: string; spent: string; reserved: string; remaining: string } | null; monthly: { limit: string; spent: string; remaining: string } | null }[] {
    const now = this.now();
    const primary = this.policy.agents[0]?.account ?? this.policy.doc.agent ?? '';
    const view = this.ledger.withClock(now).viewFor(primary);
    const limits = this.policy.agentLimits.get(primary) ?? this.policy.limits;
    const ids = new Set<string>([
      ...limits.perTx.keys(),
      ...limits.daily.keys(),
      ...limits.monthly.keys(),
    ]);
    const out = [];
    for (const id of ids) {
      const asset = this.policy.assets.get(id);
      if (!asset) continue;
      const dailyLimit = limits.daily.get(id);
      const monthlyLimit = limits.monthly.get(id);
      const dailySpent = view.spent(id, 'day');
      const dailyReserved = view.reserved(id, 'day');
      const monthlySpent = view.spent(id, 'month');
      out.push({
        asset: id,
        perTx: limits.perTx.has(id) ? formatAmount(limits.perTx.get(id) as bigint, asset.decimals) : null,
        daily: dailyLimit
          ? {
              limit: formatAmount(dailyLimit, asset.decimals),
              spent: formatAmount(dailySpent, asset.decimals),
              reserved: formatAmount(dailyReserved, asset.decimals),
              remaining: formatAmount(dailyLimit - dailySpent - dailyReserved > 0n ? dailyLimit - dailySpent - dailyReserved : 0n, asset.decimals),
            }
          : null,
        monthly: monthlyLimit
          ? {
              limit: formatAmount(monthlyLimit, asset.decimals),
              spent: formatAmount(monthlySpent, asset.decimals),
              remaining: formatAmount(monthlyLimit - monthlySpent > 0n ? monthlyLimit - monthlySpent : 0n, asset.decimals),
            }
          : null,
      });
    }
    return out;
  }

  get historyLength(): number {
    return this.history.length;
  }

  snapshot(): GuardState {
    const agents: Record<string, AgentRecord> = {};
    for (const [account, record] of this.agents) {
      agents[account] = {
        state: cloneAgent(record.state),
        lastCleanSpendAt: record.lastCleanSpendAt,
        registeredAt: record.registeredAt,
      };
    }
    return {
      version: 2,
      policyHash: this.policy.hash,
      policy: this.policy.doc,
      ledger: this.ledger.toJSON(),
      audit: this.audit.toJSON(),
      approvals: this.approvals,
      attempts: this.attempts,
      agents,
      vaultBreaker: { ...this.vaultBreaker },
      timelocks: this.timelocks,
    };
  }

  save(dir?: string): string {
    const target = dir ?? this.config.stateDir ?? 'data';
    mkdirSync(target, { recursive: true });
    const file = join(target, STATE_FILE);
    const state = this.snapshot();
    // Anomaly sums are bigint in memory and JSON has no bigint. Persist them as
    // exact decimal strings; restore() reads them back with BigInt().
    const serializable = {
      ...state,
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([account, record]) => [
          account,
          {
            ...record,
            state: {
              ...record.state,
              anomaly: {
                ...record.state.anomaly,
                txSizeSum: record.state.anomaly.txSizeSum.toString(),
                txSizeSqSum: record.state.anomaly.txSizeSqSum.toString(),
                drainageAmount: record.state.anomaly.drainageAmount.toString(),
              },
            },
          },
        ]),
      ),
    };
    writeFileSync(file, JSON.stringify(serializable, null, 2), 'utf8');
    return file;
  }

  /** Load a guard from a saved state file plus the policy that produced it. */
  static load(policyText: string, stateDir: string, config: Partial<GuardConfig> = {}): FeralGuard {
    const file = join(stateDir, STATE_FILE);
    if (!existsSync(file)) throw new Error(`no state at ${file}`);
    const state = JSON.parse(readFileSync(file, 'utf8')) as GuardState;
    const guard = FeralGuard.create({ policyText, stateDir, ...config });
    if (state.policyHash !== guard.policyHash) {
      throw new Error(`state was produced by policy ${state.policyHash}, current policy is ${guard.policyHash}`);
    }
    guard.restore(state);
    return guard;
  }

  restore(state: GuardState): void {
    this.ledger = FeralLedger.fromJSON(state.ledger, this.now());
    this.audit = AuditLog.fromJSON(state.audit);
    this.approvals = state.approvals ?? [];
    this.attempts = state.attempts ?? [];
    this.vaultBreaker = state.vaultBreaker ?? normalState();
    this.timelocks = state.timelocks ?? [];
    this.agents = new Map();
    for (const [account, record] of Object.entries(state.agents ?? {})) {
      const anomaly = record.state?.anomaly ?? freshAnomalyState(this.now());
      this.agents.set(account, {
        state: {
          ...record.state,
          account,
          knownCounterparties: record.state?.knownCounterparties ?? [],
          anomaly: {
            ...freshAnomalyState(this.now()),
            ...anomaly,
            txSizeSum: BigInt(anomaly.txSizeSum as unknown as string),
            txSizeSqSum: BigInt(anomaly.txSizeSqSum as unknown as string),
            drainageAmount: BigInt(anomaly.drainageAmount as unknown as string),
            flags: [...(anomaly.flags ?? [])],
          },
        },
        lastCleanSpendAt: record.lastCleanSpendAt ?? this.now(),
        registeredAt: record.registeredAt ?? this.now(),
      });
    }
    this.seedAgents();
    this.history = [];
  }

  /** Verify the audit chain and report the head, which a caller can anchor on-chain. */
  verifyAudit(): { ok: boolean; records: number; head: string; brokenAt?: number; reason?: string } {
    return this.audit.verify();
  }

  /** Expire stale approvals and drop their reservations. */
  sweep(): { expired: number; approvals: ApprovalRequest[] } {
    const now = this.now();
    this.ledger.pruneExpired();
    let expired = 0;
    for (const approval of this.approvals) {
      if (approval.status === 'pending' && Date.parse(approval.expiresAt) < now) {
        approval.status = 'expired';
        approval.decidedAt = new Date(now).toISOString();
        this.release(approval.actionId);
        expired++;
      }
    }
    return { expired, approvals: this.approvals };
  }
}
