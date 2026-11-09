/**
 * The decision engine.
 *
 * `evaluate()` is a pure function: policy + action + ledger snapshot -> decision.
 * It never writes state, never calls the network, and never reads the action's
 * free-text `reason` for control flow. That last point is the whole design: an
 * agent can talk, but talking cannot widen a limit.
 *
 * In Feral this function is a *mirror* of the on-chain `evaluate()`. The contract
 * is the enforcement point; this engine exists for previews, simulation, the
 * dashboard and the adversarial test harness. It runs the same twenty checks in
 * the same order so a preview cannot disagree with the chain.
 *
 * Order:
 *   1. structural validity (is this action well formed at all?)
 *   2. replay and identity (is this the right agent, a fresh request?)
 *   3. policy state (paused, expired)
 *   4. vault and agent circuit breakers, attestation, reputation floor
 *   5. action kind, burst anomaly
 *   6. hard bounds (per-tx, daily, monthly), reputation- and breaker-adjusted
 *   7. aggregate vault limits
 *   8. counterparty controls (deny list, allow list)
 *   9. velocity (rate limits)
 *  10. intent-specific controls (venue, slippage, quote expiry, destination)
 *  11. drainage and deviation anomalies
 *  12. escalation (human approval, risk heuristics) - may only tighten
 *
 * Every check is reported, not just the first failure, so a judge (or the owner)
 * can see exactly which walls the agent hit.
 */
import { AmountError, formatAmount, parseAmount, usdCents, type Asset } from './money.ts';
import { ACTION_KINDS, isValidAccountId, type ActionKind, type AssetLimits, type CompiledPolicy } from './policy.ts';
import type { LedgerView, Window } from './ledger.ts';
import type { Verdict } from './audit.ts';
import { hashObject, sha256Hex } from './canonical.ts';
import { effectiveLimit } from './reputation.ts';
import {
  detectBurst,
  detectDeviation,
  detectDrainage,
  scoreAnomaly,
  type AnomalyConfig,
  type AnomalyState,
} from './anomaly.ts';
import type { BreakerLevel, CircuitBreakerState } from './circuit.ts';

export const REASON = {
  ACTOR_NOT_AGENT: 'ACTOR_NOT_AGENT',
  POLICY_PAUSED: 'POLICY_PAUSED',
  POLICY_EXPIRED: 'POLICY_EXPIRED',
  ACTION_NOT_ALLOWED: 'ACTION_NOT_ALLOWED',
  INVALID_ACTION: 'INVALID_ACTION',
  UNKNOWN_ASSET: 'UNKNOWN_ASSET',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  NON_POSITIVE_AMOUNT: 'NON_POSITIVE_AMOUNT',
  NO_LIMIT_FOR_ASSET: 'NO_LIMIT_FOR_ASSET',
  PER_TX_LIMIT: 'PER_TX_LIMIT',
  DAILY_LIMIT: 'DAILY_LIMIT',
  MONTHLY_LIMIT: 'MONTHLY_LIMIT',
  RECIPIENT_DENIED: 'RECIPIENT_DENIED',
  RECIPIENT_NOT_ALLOWED: 'RECIPIENT_NOT_ALLOWED',
  INVALID_RECIPIENT: 'INVALID_RECIPIENT',
  VENUE_NOT_ALLOWED: 'VENUE_NOT_ALLOWED',
  SLIPPAGE_TOO_HIGH: 'SLIPPAGE_TOO_HIGH',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  MISSING_QUOTE: 'MISSING_QUOTE',
  DESTINATION_NOT_ALLOWED: 'DESTINATION_NOT_ALLOWED',
  ORIGIN_ASSET_MISMATCH: 'ORIGIN_ASSET_MISMATCH',
  RATE_LIMIT_HOURLY: 'RATE_LIMIT_HOURLY',
  RATE_LIMIT_INTERVAL: 'RATE_LIMIT_INTERVAL',
  REPLAY: 'REPLAY',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_UNAVAILABLE: 'APPROVAL_UNAVAILABLE',
  UNPRICED_ASSET: 'UNPRICED_ASSET',
  RISK_BUDGET_SHARE: 'RISK_BUDGET_SHARE',
  RISK_NEW_COUNTERPARTY: 'RISK_NEW_COUNTERPARTY',
  EMERGENCY_FREEZE: 'EMERGENCY_FREEZE',
  VAULT_PAUSED: 'VAULT_PAUSED',
  AGENT_PAUSED: 'AGENT_PAUSED',
  ATTESTATION_REQUIRED: 'ATTESTATION_REQUIRED',
  ATTESTATION_MISMATCH: 'ATTESTATION_MISMATCH',
  AGENT_NOT_FOUND: 'AGENT_NOT_FOUND',
  AGGREGATE_DAILY_LIMIT: 'AGGREGATE_DAILY_LIMIT',
  AGGREGATE_MONTHLY_LIMIT: 'AGGREGATE_MONTHLY_LIMIT',
  ANOMALY_DRAINAGE: 'ANOMALY_DRAINAGE',
  ANOMALY_DEVIATION: 'ANOMALY_DEVIATION',
  ANOMALY_BURST: 'ANOMALY_BURST',
  REPUTATION_FROZEN: 'REPUTATION_FROZEN',
  EXECUTION_FAILED: 'EXECUTION_FAILED',
} as const;

export type ReasonCode = (typeof REASON)[keyof typeof REASON];

export interface QuoteSnapshot {
  venue?: string;
  depositAddress?: string;
  destinationAddress?: string;
  /** Policy asset id the quote spends, e.g. "NEAR". */
  originAsset?: string;
  /** Raw venue asset id, e.g. "nep141:wrap.near". Informational. */
  originAssetId?: string;
  destinationAsset?: string;
  amountIn?: string;
  amountOut?: string;
  minAmountOut?: string;
  slippageBps?: number;
  /** ISO timestamp after which the quote must not be used. */
  expiresAt?: string;
}

export interface ActionRequest {
  /** Idempotency key. Reusing it is a denial, not a second spend. */
  id: string;
  kind: ActionKind;
  actor: string;
  asset: string;
  amount: string;
  to?: string;
  venue?: string;
  slippageBps?: number;
  destinationAddress?: string;
  destinationAsset?: string;
  quote?: QuoteSnapshot;
  /** TEE attestation proof; hashed and compared to the registered agent hash. */
  attestationProof?: string;
  /** Untrusted, agent-authored text. Stored for the audit trail, never obeyed. */
  reason?: string;
  requestedAt?: string;
}

export interface Reason {
  code: ReasonCode | string;
  severity: 'deny' | 'approval' | 'info';
  message: string;
}

export interface CheckResult {
  id: string;
  title: string;
  passed: boolean;
  severity: 'deny' | 'approval' | 'info';
  detail: string;
}

export interface RiskAssessment {
  score: number;
  level: 'low' | 'medium' | 'high';
  flags: { code: string; message: string }[];
}

export interface AgentState {
  account: string;
  reputation: number;
  paused: boolean;
  tier: string;
  attestationHash: string;
  txCount: number;
  denyCount: number;
  /** 0-4, mirrors the contract's per-agent breaker. */
  circuitBreaker: number;
  /** Epoch ms when the breaker expires (0 = manual reset required). */
  cbExpiresAt: number;
  /** Epoch ms of the last spend. */
  lastSpendAt: number;
  knownCounterparties: string[];
  anomaly: AnomalyState;
}

export interface VaultBreakerState {
  level: number;
  triggeredAt: number;
  expiresAt: number;
  reason: string;
}

export interface AggregateLimit {
  assetId: string;
  perTx: bigint;
  daily: bigint;
  monthly: bigint;
}

export interface AggregateView {
  /** Asset id -> vault-wide cap. */
  limits: Map<string, bigint>;
  /** Asset id -> daily spend already booked (committed + reserved). */
  spent: Map<string, bigint>;
  /** Asset id -> monthly spend already booked. */
  monthlySpent: Map<string, bigint>;
}

export interface FeralEvaluateContext {
  /** Override the clock, ms since epoch. */
  now?: number;
  /** Asset id -> price in micro-USD per whole unit (1_000_000n === $1). */
  prices?: Record<string, bigint>;
  agentState?: AgentState;
  vaultBreaker?: VaultBreakerState;
  aggregateView?: AggregateView;
  attestationProof?: string;
  actionKind?: string;
}

/** Backwards-compatible alias: a context without Feral state is a plain dry run. */
export type EvaluateContext = FeralEvaluateContext;

export interface Decision {
  decisionId: string;
  actionId: string;
  verdict: Verdict;
  reasons: Reason[];
  checks: CheckResult[];
  risk: RiskAssessment;
  policyHash: string;
  policyName: string;
  actor: string;
  kind: ActionKind;
  asset: string;
  amount: string;
  evaluatedAt: string;
  amountMinor: string | null;
  amountUsdCents: string | null;
  limits: {
    perTx: string | null;
    daily: { limit: string; spent: string; reserved: string; remaining: string } | null;
    monthly: { limit: string; spent: string; reserved: string; remaining: string } | null;
  };
  requiresApproval: { approvers: string[]; expiresAt: string; ttlSeconds: number } | null;
  /** Agent state at decision time, when the caller supplied it. */
  reputation: number | null;
  anomalyScore: number | null;
  circuitBreakerLevel: number | null;
  fingerprint: string;
}

export interface WindowSnapshot {
  limit: bigint;
  remaining: bigint;
  spent: bigint;
  reserved: bigint;
}

/** Hash a TEE attestation proof the same way the contract does. */
export function attestationHash(proof: string): string {
  return sha256Hex(proof);
}

/** Basis points of a limit after reputation and breaker adjustment. */
export function reputationFactor(reputation: number): bigint {
  return BigInt(Math.max(0, Math.min(100, Math.trunc(reputation))) * 100);
}

export function effectiveLimitFor(baseLimit: bigint, reputation: number, breakerFraction = 1): bigint {
  const repBps = reputationFactor(reputation);
  const breakerBps = BigInt(Math.round(breakerFraction * 10_000));
  return (baseLimit * repBps * breakerBps) / 10_000n / 10_000n;
}

export function scoreAnomalyFor(
  agentState: AgentState,
  action: ActionRequest,
  amountMinor: bigint,
  now: number,
  config: AnomalyConfig,
): { score: number; flags: string[] } {
  let score = agentState.anomaly.anomalyScore;
  const flags = [...agentState.anomaly.flags];
  if (detectBurst(agentState.anomaly, now, config)) {
    score = Math.min(100, score + 30);
    if (!flags.includes('BURST')) flags.push('BURST');
  }
  if (agentState.anomaly.txCount >= 10) {
    const mean = agentState.anomaly.txSizeSum / BigInt(agentState.anomaly.txCount);
    if (mean > 0n && amountMinor > mean * BigInt(config.deviationSigma)) {
      score = Math.min(100, score + 25);
      if (!flags.includes('DEVIATION')) flags.push('DEVIATION');
    }
  }
  void action;
  return { score: Math.max(0, Math.min(100, score)), flags };
}

export interface SimulationDiff {
  actionId: string;
  oldVerdict: Verdict;
  newVerdict: Verdict;
  oldReasons: string[];
  newReasons: string[];
}

export interface SimulationResult {
  diffs: SimulationDiff[];
  totalActions: number;
  changedCount: number;
}

const HOUR_MS = 3_600_000;

export const DEFAULT_PRICES: Record<string, bigint> = {
  NEAR: 2_450_000n, // $2.45
  USDC: 1_000_000n,
  USDT: 1_000_000n,
};

interface Draft {
  checks: CheckResult[];
  reasons: Reason[];
}

function add(
  draft: Draft,
  check: { id: string; title: string; passed: boolean; severity: 'deny' | 'approval' | 'info'; detail: string },
  code?: ReasonCode,
): void {
  draft.checks.push(check);
  if (!check.passed) {
    draft.reasons.push({ code: code ?? check.id, severity: check.severity, message: check.detail });
  }
}

function fmt(value: bigint | undefined, asset: Asset | undefined): string | null {
  if (value === undefined) return null;
  if (!asset) return value.toString();
  return formatAmount(value, asset.decimals);
}

function bump(score: number, points: number): number {
  return Math.min(100, score + points);
}

function breakerActive(breaker: VaultBreakerState | undefined, now: number, level: number): boolean {
  if (!breaker) return false;
  if (breaker.level < level) return false;
  if (breaker.expiresAt === 0) return true;
  return breaker.expiresAt > now;
}

/**
 * Evaluate one action against a policy.
 *
 * The ledger view is only read; the caller decides whether to reserve budget,
 * commit it, or do nothing (dry run).
 */
export function evaluate(
  policy: CompiledPolicy,
  action: ActionRequest,
  view: LedgerView,
  ctx: FeralEvaluateContext = {},
): Decision {
  const now = ctx.now ?? view.now;
  const prices = ctx.prices ?? DEFAULT_PRICES;
  const draft: Draft = { checks: [], reasons: [] };
  const at = new Date(now).toISOString();
  const asset = policy.assets.get(action.asset);
  const doc = policy.doc;
  const agentState = ctx.agentState;

  const limits: AssetLimits = agentState
    ? policy.agentLimits.get(action.actor) ?? { perTx: policy.limits.perTx, daily: policy.limits.daily, monthly: policy.limits.monthly }
    : { perTx: policy.limits.perTx, daily: policy.limits.daily, monthly: policy.limits.monthly };

  const nowReputation = agentState?.reputation ?? 100;
  const cbReduced = agentState
    ? agentState.circuitBreaker === 1 && agentState.cbExpiresAt > now
    : false;
  const vaultReduced = breakerActive(ctx.vaultBreaker, now, 1) && ctx.vaultBreaker?.level === 1;
  const breakerFraction = cbReduced || vaultReduced ? 0.1 : 1;
  const scale = (base: bigint): bigint =>
    agentState || breakerFraction !== 1 || vaultReduced
      ? effectiveLimitFor(base, nowReputation, breakerFraction)
      : base;

  let amountMinor: bigint | null = null;
  let amountText: string | null = null;
  let amountUsd: bigint | null = null;
  let riskScore = 0;
  const riskFlags: { code: string; message: string }[] = [];

  // ---- 1. structural validity ------------------------------------------------
  const shapeProblems: string[] = [];
  if (typeof action.id !== 'string' || action.id.trim().length === 0) shapeProblems.push('missing action id');
  if (typeof action.actor !== 'string' || action.actor.length === 0) shapeProblems.push('missing actor');
  if (!ACTION_KINDS.includes(action.kind)) shapeProblems.push(`unknown action kind: ${String(action.kind)}`);
  if (typeof action.asset !== 'string' || action.asset.length === 0) shapeProblems.push('missing asset');
  add(draft, {
    id: 'structure',
    title: 'Request shape',
    passed: shapeProblems.length === 0,
    severity: 'deny',
    detail: shapeProblems.length === 0 ? 'request is well formed' : shapeProblems.join(', '),
  }, REASON.INVALID_ACTION);

  if (asset === undefined) {
    add(draft, {
      id: 'asset-registry',
      title: 'Asset is declared in the policy',
      passed: false,
      severity: 'deny',
      detail: `asset "${action.asset}" is not in the policy registry, so no limit applies to it`,
    }, REASON.UNKNOWN_ASSET);
  } else {
    try {
      amountMinor = parseAmount(action.amount, asset.decimals);
      amountText = formatAmount(amountMinor, asset.decimals);
      add(draft, {
        id: 'amount-parses',
        title: 'Amount is exact',
        passed: true,
        severity: 'deny',
        detail: `${amountText} ${asset.symbol} parses to ${amountMinor} base units (${asset.decimals} decimals)`,
      });
    } catch (err) {
      add(draft, {
        id: 'amount-parses',
        title: 'Amount is exact',
        passed: false,
        severity: 'deny',
        detail: (err as AmountError).message,
      }, REASON.INVALID_AMOUNT);
    }
  }

  if (amountMinor !== null) {
    add(draft, {
      id: 'amount-positive',
      title: 'Amount is positive',
      passed: amountMinor > 0n,
      severity: 'deny',
      detail: amountMinor > 0n ? 'amount is greater than zero' : 'amount must be greater than zero',
    }, REASON.NON_POSITIVE_AMOUNT);
  }

  // ---- 2. identity and replay ------------------------------------------------
  const registeredAgents = new Set<string>([...policy.agentLimits.keys(), ...policy.agents.map((a) => a.account)]);
  if (doc.agent) registeredAgents.add(doc.agent);
  add(draft, {
    id: 'actor',
    title: 'Actor is a registered agent',
    passed: registeredAgents.has(action.actor),
    severity: 'deny',
    detail: registeredAgents.has(action.actor)
      ? `actor ${action.actor} is a registered agent`
      : `actor ${String(action.actor)} is not an agent of this vault (${[...registeredAgents].join(', ')})`,
  }, REASON.ACTOR_NOT_AGENT);

  add(draft, {
    id: 'replay',
    title: 'Action id is fresh',
    passed: !view.hasAttempted(action.id),
    severity: 'deny',
    detail: view.hasAttempted(action.id)
      ? `action id ${action.id} was already evaluated; replaying it cannot spend twice`
      : `action id ${action.id} has not been seen before`,
  }, REASON.REPLAY);

  // ---- 3. policy state -------------------------------------------------------
  add(draft, {
    id: 'paused',
    title: 'Policy is armed',
    passed: doc.paused !== true,
    severity: 'deny',
    detail: doc.paused === true ? 'policy is paused by the owner' : 'policy is active',
  }, REASON.POLICY_PAUSED);

  const expired = policy.expiresAt !== null && now > policy.expiresAt;
  add(draft, {
    id: 'expiry',
    title: 'Policy has not expired',
    passed: !expired,
    severity: 'deny',
    detail: expired ? `policy expired at ${new Date(policy.expiresAt as number).toISOString()}` : 'policy is within its validity window',
  }, REASON.POLICY_EXPIRED);

  // ---- 4. circuit breakers, attestation, reputation floor --------------------
  const vault = ctx.vaultBreaker;
  if (vault && vault.level >= 4) {
    add(draft, {
      id: 'vault-freeze',
      title: 'Vault is not emergency-frozen',
      passed: false,
      severity: 'deny',
      detail: 'vault is emergency-frozen; no agent can spend',
    }, REASON.EMERGENCY_FREEZE);
  } else if (vault && vault.level >= 3 && vault.expiresAt === 0) {
    add(draft, {
      id: 'vault-paused',
      title: 'Vault is not paused',
      passed: false,
      severity: 'deny',
      detail: 'vault is paused by governance',
    }, REASON.VAULT_PAUSED);
  }

  if (agentState) {
    if (agentState.paused) {
      add(draft, {
        id: 'agent-paused',
        title: 'Agent is not paused',
        passed: false,
        severity: 'deny',
        detail: 'agent is paused by the owner',
      }, REASON.AGENT_PAUSED);
    }
    if (agentState.circuitBreaker >= 2) {
      add(draft, {
        id: 'agent-breaker',
        title: 'Agent circuit breaker is clear',
        passed: false,
        severity: 'deny',
        detail: `agent circuit breaker is at level ${agentState.circuitBreaker}`,
      }, REASON.AGENT_PAUSED);
    }
    if (agentState.attestationHash) {
      const proof = ctx.attestationProof;
      const ok = proof !== undefined && attestationHash(proof) === agentState.attestationHash;
      add(draft, {
        id: 'attestation',
        title: 'TEE attestation matches the registered binary',
        passed: ok,
        severity: 'deny',
        detail: proof === undefined
          ? 'attestation proof required but not provided'
          : ok
            ? 'attestation proof hashes to the registered value'
            : 'attestation proof does not hash to the registered value',
      }, proof === undefined ? REASON.ATTESTATION_REQUIRED : REASON.ATTESTATION_MISMATCH);
    }
    add(draft, {
      id: 'reputation-floor',
      title: 'Reputation is above the freeze threshold',
      passed: agentState.reputation > 0,
      severity: 'deny',
      detail: agentState.reputation > 0
        ? `reputation ${agentState.reputation} is above the freeze threshold`
        : 'agent reputation is 0, the agent is frozen',
    }, REASON.REPUTATION_FROZEN);
  }

  // ---- 5. action kind --------------------------------------------------------
  const deniedKind = policy.deniedActions.has(action.kind);
  const notInAllowlist = policy.allowedActions !== null && !policy.allowedActions.has(action.kind);
  add(draft, {
    id: 'action-kind',
    title: 'Action kind is permitted',
    passed: !deniedKind && !notInAllowlist,
    severity: 'deny',
    detail: deniedKind
      ? `${action.kind} is explicitly denied by the policy`
      : notInAllowlist
        ? `${action.kind} is not in the allowed action list`
        : `${action.kind} is permitted`,
  }, REASON.ACTION_NOT_ALLOWED);

  // ---- 5b. burst anomaly (before limits, so it is attributed correctly) -----
  if (agentState && detectBurst(agentState.anomaly, now, policy.anomaly)) {
    const seen = agentState.anomaly.burstCount;
    add(draft, {
      id: 'anomaly-burst',
      title: 'No burst anomaly',
      passed: false,
      severity: 'deny',
      detail: `${seen} transfers inside ${Math.round(policy.anomaly.burstWindowMs / 1000)}s; burst threshold is ${policy.anomaly.burstThreshold}`,
    }, REASON.ANOMALY_BURST);
  }

  // ---- 6. hard money bounds --------------------------------------------------
  let dailySnapshot: WindowSnapshot | null = null;
  let monthlySnapshot: WindowSnapshot | null = null;
  let effectiveDaily: bigint | null = null;

  if (asset && amountMinor !== null && amountMinor > 0n) {
    const basePerTx = limits.perTx.get(asset.id);
    const perTx = basePerTx === undefined ? undefined : scale(basePerTx);
    if (perTx !== undefined) {
      add(draft, {
        id: 'per-tx',
        title: 'Per-transaction limit',
        passed: amountMinor <= perTx,
        severity: 'deny',
        detail:
          amountMinor <= perTx
            ? `${amountText} ${asset.symbol} is within the ${formatAmount(perTx, asset.decimals)} ${asset.symbol} per-tx limit`
            : `${amountText} ${asset.symbol} exceeds the ${formatAmount(perTx, asset.decimals)} ${asset.symbol} per-tx limit${
                perTx !== basePerTx ? ` (adjusted from ${formatAmount(basePerTx as bigint, asset.decimals)} by reputation ${nowReputation}${breakerFraction < 1 ? ' and the circuit breaker' : ''})` : ''
              }`,
      }, REASON.PER_TX_LIMIT);
      if (amountMinor > perTx) riskScore = bump(riskScore, 25);
    } else if (policy.limits.defaultPerTxUsdCents !== undefined) {
      const price = prices[asset.id];
      if (price === undefined) {
        add(draft, {
          id: 'per-tx',
          title: 'Per-transaction limit',
          passed: false,
          severity: 'deny',
          detail: `no USD price for ${asset.id}, so the ${formatAmount(policy.limits.defaultPerTxUsdCents, 2)} USD cap cannot be checked`,
        }, REASON.UNPRICED_ASSET);
      } else {
        const cents = usdCents(amountMinor, asset, prices);
        add(draft, {
          id: 'per-tx',
          title: 'Per-transaction limit (USD)',
          passed: cents <= policy.limits.defaultPerTxUsdCents,
          severity: 'deny',
          detail: `$${formatAmount(cents, 2)} vs $${formatAmount(policy.limits.defaultPerTxUsdCents, 2)} default cap`,
        }, REASON.PER_TX_LIMIT);
      }
    } else {
      add(draft, {
        id: 'per-tx',
        title: 'Per-transaction limit',
        passed: false,
        severity: 'deny',
        detail: `no per-transaction limit is configured for ${asset.id}`,
      }, REASON.NO_LIMIT_FOR_ASSET);
    }

    const windowCheck = (id: 'daily' | 'monthly', title: string): WindowSnapshot | null => {
      const window: Window = id === 'daily' ? 'day' : 'month';
      const baseLimit = id === 'daily' ? limits.daily.get(asset.id) : limits.monthly.get(asset.id);
      if (baseLimit === undefined) {
        add(draft, {
          id: `${id}-budget`,
          title,
          passed: true,
          severity: 'deny',
          detail: `no ${id} budget configured for ${asset.id}`,
        });
        return null;
      }
      const limit = scale(baseLimit);
      if (id === 'daily') effectiveDaily = limit;
      const spent = view.spent(asset.id, window);
      const reserved = view.reserved(asset.id, window);
      const remaining = limit - spent - reserved;
      const ok = amountMinor as bigint <= remaining;
      add(draft, {
        id: `${id}-budget`,
        title,
        passed: ok,
        severity: 'deny',
        detail: ok
          ? `${amountText} of ${formatAmount(remaining, asset.decimals)} ${asset.symbol} remaining`
          : `${amountText} ${asset.symbol} exceeds the remaining ${id} budget of ${formatAmount(remaining > 0n ? remaining : 0n, asset.decimals)} ${asset.symbol} (limit ${formatAmount(limit, asset.decimals)}, spent ${formatAmount(spent, asset.decimals)}, reserved ${formatAmount(reserved, asset.decimals)})`,
      }, id === 'daily' ? REASON.DAILY_LIMIT : REASON.MONTHLY_LIMIT);

      if (limit > 0n) {
        const usedFraction = Number((amountMinor as bigint * 100n) / limit);
        if (usedFraction >= 80) {
          riskFlags.push({ code: 'NEAR_DAILY_CAP', message: `${usedFraction}% of the ${id} budget in one request` });
          riskScore = bump(riskScore, 15);
        }
      }
      return { limit, remaining, spent, reserved };
    };

    dailySnapshot = windowCheck('daily', 'Daily budget');
    monthlySnapshot = windowCheck('monthly', 'Monthly budget');

    // ---- 7. aggregate vault limits --------------------------------------
    if (ctx.aggregateView) {
      const aggDaily = ctx.aggregateView.limits.get(asset.id);
      if (aggDaily !== undefined) {
        const spent = ctx.aggregateView.spent.get(asset.id) ?? 0n;
        const remaining = aggDaily - spent;
        const ok = amountMinor <= remaining;
        add(draft, {
          id: 'aggregate-daily',
          title: 'Aggregate daily limit across agents',
          passed: ok,
          severity: 'deny',
          detail: ok
            ? `${amountText} of ${formatAmount(remaining, asset.decimals)} ${asset.symbol} left in the vault daily cap`
            : `${amountText} ${asset.symbol} exceeds the aggregate daily budget; ${formatAmount(spent, asset.decimals)} of ${formatAmount(aggDaily, asset.decimals)} ${asset.symbol} already used across agents`,
        }, REASON.AGGREGATE_DAILY_LIMIT);
      }
      const aggMonthly = ctx.aggregateView.limits.get(`${asset.id}:month`) ?? policy.aggregateLimits.monthly.get(asset.id);
      if (aggMonthly !== undefined) {
        const spent = ctx.aggregateView.monthlySpent.get(asset.id) ?? 0n;
        const remaining = aggMonthly - spent;
        const ok = amountMinor <= remaining;
        add(draft, {
          id: 'aggregate-monthly',
          title: 'Aggregate monthly limit across agents',
          passed: ok,
          severity: 'deny',
          detail: ok
            ? `${amountText} of ${formatAmount(remaining, asset.decimals)} ${asset.symbol} left in the vault monthly cap`
            : `${amountText} ${asset.symbol} exceeds the aggregate monthly budget; ${formatAmount(spent, asset.decimals)} of ${formatAmount(aggMonthly, asset.decimals)} ${asset.symbol} already used across agents`,
        }, REASON.AGGREGATE_MONTHLY_LIMIT);
      }
    }

    if (policy.approval.thresholdUsdCents !== undefined) {
      const price = prices[asset.id];
      if (price === undefined) {
        add(draft, {
          id: 'usd-price',
          title: 'USD value is known',
          passed: false,
          severity: 'deny',
          detail: `no USD price for ${asset.id}; an unpriced asset cannot be compared to the approval threshold`,
        }, REASON.UNPRICED_ASSET);
      } else {
        amountUsd = usdCents(amountMinor, asset, prices);
        add(draft, {
          id: 'usd-price',
          title: 'USD value is known',
          passed: true,
          severity: 'deny',
          detail: `$${formatAmount(amountUsd, 2)} at the configured price`,
        });
        const over = amountUsd > policy.approval.thresholdUsdCents;
        add(draft, {
          id: 'approval-threshold',
          title: `Human approval above $${formatAmount(policy.approval.thresholdUsdCents!, 2)}`,
          passed: !over,
          severity: 'approval',
          detail: over
            ? `$${formatAmount(amountUsd, 2)} is above the approval threshold, a human must co-sign`
            : `$${formatAmount(amountUsd, 2)} is below the approval threshold`,
        }, REASON.APPROVAL_REQUIRED);
      }
    }
  }

  // ---- 8. counterparty controls ---------------------------------------------
  const recipient = action.to ?? null;
  if (recipient !== null) {
    const valid = isValidAccountId(recipient);
    add(draft, {
      id: 'recipient-format',
      title: 'Recipient is a valid account id',
      passed: valid,
      severity: 'deny',
      detail: valid ? `recipient ${recipient} is a valid NEAR account id` : `recipient ${recipient} is not a valid account id`,
    }, REASON.INVALID_RECIPIENT);

    if (valid) {
      const denied = policy.deny.has(recipient);
      add(draft, {
        id: 'recipient-deny',
        title: 'Recipient is not blocked',
        passed: !denied,
        severity: 'deny',
        detail: denied ? `recipient ${recipient} is on the deny list` : `recipient ${recipient} is not on the deny list`,
      }, REASON.RECIPIENT_DENIED);

      const allowed = policy.allow.has(recipient);
      const strictFail = policy.strictCounterparties && !allowed;
      add(draft, {
        id: 'recipient-allow',
        title: policy.strictCounterparties ? 'Recipient is on the allow list' : 'Recipient allow list (open mode)',
        passed: !strictFail,
        severity: 'deny',
        detail: strictFail
          ? `recipient ${recipient} is not on the allow list, so the agent cannot send there`
          : `recipient ${recipient} is ${allowed ? 'explicitly allowed' : 'not restricted (open mode)'}`,
      }, REASON.RECIPIENT_NOT_ALLOWED);

      if (!allowed && policy.requireApprovalForNew) {
        add(draft, {
          id: 'new-recipient',
          title: 'First payment to a new recipient needs a human',
          passed: false,
          severity: 'approval',
          detail: `recipient ${recipient} has not been approved before`,
        }, REASON.APPROVAL_REQUIRED);
      }

      if (!view.isKnownCounterparty(recipient)) {
        riskFlags.push({ code: 'NEW_COUNTERPARTY', message: `first payment to ${recipient}` });
        riskScore = bump(riskScore, policy.risk.escalateOnNewCounterparty ? 35 : 10);
      }
    }
  }

  // ---- 9. velocity -----------------------------------------------------------
  if (policy.velocity.maxTxPerHour > 0) {
    const count = view.txCountSince(now - HOUR_MS);
    add(draft, {
      id: 'velocity-hourly',
      title: `At most ${policy.velocity.maxTxPerHour} transfers per hour`,
      passed: count < policy.velocity.maxTxPerHour,
      severity: 'deny',
      detail: `${count} transfers in the last hour`,
    }, REASON.RATE_LIMIT_HOURLY);
  }

  if (policy.velocity.minIntervalSeconds > 0) {
    const last = view.lastSpendAt();
    const gapMs = last === null ? Number.POSITIVE_INFINITY : now - last;
    const ok = gapMs >= policy.velocity.minIntervalSeconds * 1000;
    add(draft, {
      id: 'velocity-interval',
      title: `At least ${policy.velocity.minIntervalSeconds}s between transfers`,
      passed: ok,
      severity: 'deny',
      detail: Number.isFinite(gapMs) ? `${Math.round(gapMs / 1000)}s since the last transfer` : 'no previous transfer',
    }, REASON.RATE_LIMIT_INTERVAL);
  }

  // ---- 10. intent-specific controls -----------------------------------------
  if (action.kind === 'intent.swap') {
    const quote = action.quote ?? {};
    const hasQuote = Object.keys(quote).length > 0;
    add(draft, {
      id: 'quote-present',
      title: 'Swap carries a quote to check',
      passed: hasQuote,
      severity: 'deny',
      detail: hasQuote
        ? 'quote snapshot is attached, so price, venue and destination can be verified'
        : 'no quote attached: venue, slippage, destination and expiry cannot be verified',
    }, REASON.MISSING_QUOTE);

    const venue = action.venue ?? quote.venue ?? 'near-intents';
    add(draft, {
      id: 'venue',
      title: 'Swap venue is allowed',
      passed: policy.intents.venues.has(venue),
      severity: 'deny',
      detail: policy.intents.venues.has(venue)
        ? `venue ${venue} is allowed`
        : `venue ${venue} is not in the allowed venues (${[...policy.intents.venues].join(', ')})`,
    }, REASON.VENUE_NOT_ALLOWED);

    const slippage = action.slippageBps ?? quote.slippageBps;
    if (slippage !== undefined) {
      add(draft, {
        id: 'slippage',
        title: `Slippage under ${policy.intents.maxSlippageBps} bps`,
        passed: slippage <= policy.intents.maxSlippageBps,
        severity: 'deny',
        detail:
          slippage <= policy.intents.maxSlippageBps
            ? `${slippage} bps is within the policy ceiling`
            : `${slippage} bps exceeds the ${policy.intents.maxSlippageBps} bps ceiling`,
      }, REASON.SLIPPAGE_TOO_HIGH);
    }

    if (quote.expiresAt !== undefined) {
      const expiry = Date.parse(quote.expiresAt);
      const ok = Number.isFinite(expiry) && expiry > now;
      add(draft, {
        id: 'quote-expiry',
        title: 'Quote is still valid',
        passed: ok,
        severity: 'deny',
        detail: ok
          ? `quote is valid for another ${Math.round((expiry - now) / 1000)}s`
          : `quote expired at ${quote.expiresAt}, so its price can no longer be trusted`,
      }, REASON.QUOTE_EXPIRED);
    }

    if (quote.originAsset !== undefined && quote.originAsset !== action.asset) {
      add(draft, {
        id: 'origin-asset',
        title: 'Quote spends the expected asset',
        passed: false,
        severity: 'deny',
        detail: `quote spends ${quote.originAsset} but the action declares ${action.asset}`,
      }, REASON.ORIGIN_ASSET_MISMATCH);
    }

    const destination = action.destinationAddress ?? quote.destinationAddress;
    if (policy.intents.requireAllowlistedDestination) {
      const allowed = destination !== undefined && policy.intents.allowedDestinations.has(destination.toLowerCase());
      add(draft, {
        id: 'destination',
        title: 'Swap output goes to a pinned address',
        passed: allowed,
        severity: 'deny',
        detail: destination === undefined
          ? 'the swap has no destination address, so the output cannot be pinned'
          : allowed
            ? `destination ${destination} is pinned in the policy`
            : `destination ${destination} is not pinned in the policy; a swapped quote cannot silently redirect funds`,
      }, REASON.DESTINATION_NOT_ALLOWED);
    }
  }

  // ---- 11. drainage and deviation anomalies ---------------------------------
  if (agentState && amountMinor !== null && amountMinor > 0n) {
    const dailyLimitForAnomaly = effectiveDaily ?? limits.daily.get(action.asset) ?? 0n;
    if (recipient !== null && detectDrainage(agentState.anomaly, amountMinor, recipient, dailyLimitForAnomaly, policy.anomaly)) {
      const threshold = Number(policy.anomaly.drainageThresholdBps) / 100;
      add(draft, {
        id: 'anomaly-drainage',
        title: 'No drainage anomaly',
        passed: false,
        severity: 'deny',
        detail: `drainage pattern: more than ${threshold}% of the daily limit concentrated on ${recipient}`,
      }, REASON.ANOMALY_DRAINAGE);
    }
    if (detectDeviation(agentState.anomaly, amountMinor, policy.anomaly)) {
      const mean = agentState.anomaly.txSizeSum / BigInt(Math.max(1, agentState.anomaly.txCount));
      add(draft, {
        id: 'anomaly-deviation',
        title: 'No deviation anomaly',
        passed: false,
        severity: 'deny',
        detail: `transaction is far above the baseline mean (${mean.toString()} base units)`,
      }, REASON.ANOMALY_DEVIATION);
    }
    const scored = scoreAnomalyFor(agentState, action, amountMinor, now, policy.anomaly);
    riskScore = Math.max(riskScore, scored.score);
    for (const flag of scored.flags) {
      if (!riskFlags.some((f) => f.code === flag)) riskFlags.push({ code: flag, message: `anomaly flag ${flag}` });
    }
  }

  // ---- 12. escalation from risk heuristics ----------------------------------
  if (policy.risk.escalateAboveBudgetFraction !== null && dailySnapshot !== null && amountMinor !== null) {
    const fraction = Number((amountMinor * 1000n) / (dailySnapshot.limit > 0n ? dailySnapshot.limit : 1n)) / 1000;
    if (fraction >= policy.risk.escalateAboveBudgetFraction) {
      add(draft, {
        id: 'risk-escalation',
        title: 'Large share of the daily budget needs a human',
        passed: false,
        severity: 'approval',
        detail: `this action is ${Math.round(fraction * 100)}% of the daily budget, above the ${Math.round(policy.risk.escalateAboveBudgetFraction * 100)}% escalation threshold`,
      }, REASON.RISK_BUDGET_SHARE);
    }
  }

  if (policy.risk.escalateOnNewCounterparty && riskFlags.some((f) => f.code === 'NEW_COUNTERPARTY')) {
    add(draft, {
      id: 'risk-new-counterparty',
      title: 'New counterparties need a human',
      passed: false,
      severity: 'approval',
      detail: 'the policy escalates every first payment to a new recipient',
    }, REASON.RISK_NEW_COUNTERPARTY);
  }

  // ---- verdict ---------------------------------------------------------------
  const denyReasons = draft.reasons.filter((r) => r.severity === 'deny');
  const approvalReasons = draft.reasons.filter((r) => r.severity === 'approval');
  let verdict: Verdict = 'allow';
  if (denyReasons.length > 0) verdict = 'deny';
  else if (approvalReasons.length > 0) verdict = 'require_approval';

  const hasApprovers = policy.approval.approvers.length > 0;
  if (verdict === 'require_approval' && !hasApprovers) {
    verdict = 'deny';
    draft.reasons.push({
      code: REASON.APPROVAL_UNAVAILABLE,
      severity: 'deny',
      message: 'the policy asks for human approval but no approver is configured',
    });
  }

  const level: RiskAssessment['level'] = riskScore >= 60 ? 'high' : riskScore >= 30 ? 'medium' : 'low';
  const expiresAt = new Date(now + policy.approval.ttlSeconds * 1000).toISOString();
  const amountMinorText = amountMinor === null ? null : amountMinor.toString();

  const decisionCore = {
    actionId: action.id,
    verdict,
    policyHash: policy.hash,
    reasons: draft.reasons.map((r) => r.code),
    at,
    amountMinor: amountMinorText,
  };
  const decisionId = `dec_${hashObject(decisionCore).slice(0, 16)}`;

  return {
    decisionId,
    actionId: action.id,
    verdict,
    reasons: draft.reasons,
    checks: draft.checks,
    risk: { score: riskScore, level, flags: riskFlags },
    policyHash: policy.hash,
    policyName: doc.name,
    actor: action.actor,
    kind: action.kind,
    asset: action.asset,
    amount: amountText ?? action.amount,
    evaluatedAt: at,
    amountMinor: amountMinorText,
    amountUsdCents: amountUsd === null ? null : amountUsd.toString(),
    limits: {
      perTx: fmt(
        asset ? scale(limits.perTx.get(action.asset) ?? 0n) : undefined,
        asset,
      ),
      daily: dailySnapshot
        ? {
            limit: fmt(dailySnapshot.limit, asset) as string,
            spent: fmt(dailySnapshot.spent, asset) as string,
            reserved: fmt(dailySnapshot.reserved, asset) as string,
            remaining: fmt(dailySnapshot.remaining > 0n ? dailySnapshot.remaining : 0n, asset) as string,
          }
        : null,
      monthly: monthlySnapshot
        ? {
            limit: fmt(monthlySnapshot.limit, asset) as string,
            spent: fmt(monthlySnapshot.spent, asset) as string,
            reserved: fmt(monthlySnapshot.reserved, asset) as string,
            remaining: fmt(monthlySnapshot.remaining > 0n ? monthlySnapshot.remaining : 0n, asset) as string,
          }
        : null,
    },
    requiresApproval:
      verdict === 'require_approval'
        ? { approvers: policy.approval.approvers, expiresAt, ttlSeconds: policy.approval.ttlSeconds }
        : null,
    reputation: agentState ? agentState.reputation : null,
    anomalyScore: agentState ? agentState.anomaly.anomalyScore : null,
    circuitBreakerLevel: agentState ? agentState.circuitBreaker : (vault?.level ?? null),
    fingerprint: hashObject({ ...decisionCore, checks: draft.checks.map((c) => [c.id, c.passed]) }),
  };
}

/**
 * Replay historical actions against a proposed policy and report what changes.
 * The current policy is the baseline; only differing verdicts are returned.
 */
export function simulatePolicy(
  currentPolicy: CompiledPolicy,
  proposedPolicy: CompiledPolicy,
  historicalActions: ActionRequest[],
  view: LedgerView,
  ctx: FeralEvaluateContext = {},
): SimulationResult {
  const diffs: SimulationDiff[] = [];
  for (const action of historicalActions) {
    const before = evaluate(currentPolicy, action, view, ctx);
    const after = evaluate(proposedPolicy, action, view, ctx);
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
  return { diffs, totalActions: historicalActions.length, changedCount: diffs.length };
}

export type { AnomalyConfig, AnomalyState, BreakerLevel, CircuitBreakerState };
