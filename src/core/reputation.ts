/**
 * Reputation: earned trust, expressed as a multiplier on every limit.
 *
 * Reputation is deliberately simple arithmetic so the contract and the off-chain
 * mirror can agree without shared state: a score in [0, 100], scaled limits
 * (`base * score / 100`), and an explicit list of deltas. A score of 0 freezes
 * the agent; a score of 100 gives the agent exactly the limits the owner wrote.
 */

export interface ReputationConfig {
  initial: number;
  cleanSpendBonus: number;
  denyPenalty: number;
  approvalBonus: number;
  anomalyPenalty: number;
  recoveryWindowDays: number;
  recoveryBonus: number;
  freezeThreshold: number;
}

export function defaultReputationConfig(): ReputationConfig {
  return {
    initial: 100,
    cleanSpendBonus: 1,
    denyPenalty: 10,
    approvalBonus: 2,
    anomalyPenalty: 15,
    recoveryWindowDays: 30,
    recoveryBonus: 20,
    freezeThreshold: 0,
  };
}

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.trunc(value)));

export function applyCleanSpend(current: number, config: ReputationConfig): number {
  return clamp(current + config.cleanSpendBonus);
}

export function applyDenial(current: number, config: ReputationConfig): number {
  return clamp(current - config.denyPenalty);
}

export function applyApproval(current: number, config: ReputationConfig): number {
  return clamp(current + config.approvalBonus);
}

export function applyAnomaly(current: number, config: ReputationConfig): number {
  return clamp(current - config.anomalyPenalty);
}

export function applyRecovery(current: number, config: ReputationConfig): number {
  return clamp(current + config.recoveryBonus);
}

export function isFrozen(reputation: number, config: ReputationConfig): boolean {
  return reputation <= config.freezeThreshold;
}

/** Reputation-adjusted limit, rounded down so a wall never widens by rounding. */
export function effectiveLimit(baseLimit: bigint, reputation: number): bigint {
  const bounded = Math.max(0, Math.min(100, Math.trunc(reputation)));
  return (baseLimit * BigInt(bounded)) / 100n;
}
