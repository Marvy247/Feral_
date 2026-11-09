/**
 * Anomaly detection, mirrored from the contract.
 *
 * Three independent detectors, each cheap enough to run on-chain:
 *  - burst: too many transfers inside a short window (a stolen key draining fast);
 *  - drainage: too much concentration on one destination inside the day;
 *  - deviation: one transfer far above the agent's rolling baseline.
 *
 * The detectors never *widen* anything. They either flag (reputation and the
 * dashboard), deny the specific transaction, or ask the service to tighten the
 * circuit breaker.
 */

export interface AnomalyConfig {
  burstThreshold: number;
  burstWindowMs: number;
  drainageThresholdBps: number;
  deviationSigma: number;
  baselineUpdateInterval: number;
  autoEscalate: boolean;
}

export function defaultAnomalyConfig(): AnomalyConfig {
  return {
    burstThreshold: 5,
    burstWindowMs: 60_000,
    drainageThresholdBps: 5000,
    deviationSigma: 5,
    baselineUpdateInterval: 100,
    autoEscalate: true,
  };
}

export interface AnomalyState {
  /** Rolling sum of transaction sizes, for the mean. */
  txSizeSum: bigint;
  /** Rolling sum of squared sizes, for the standard deviation. */
  txSizeSqSum: bigint;
  /** Number of transactions in the baseline. */
  txCount: number;
  /** Transactions since the last baseline refresh. */
  txSinceBaseline: number;
  /** Epoch ms of the last baseline refresh. */
  lastBaselineUpdate: number;
  /** Epoch ms of the earliest transfer in the current burst window. */
  burstWindowStart: number;
  /** Transfers seen in the current burst window. */
  burstCount: number;
  /** Total sent to the most-paid destination today. */
  drainageAmount: bigint;
  /** The destination that has received the most today. */
  drainageAddress: string | null;
  /** How many payments the drainage address has received this window. */
  drainageTxCount: number;
  /** Epoch ms when the drainage window started. */
  drainageWindowStart: number;
  /** Current score, 0-100. */
  anomalyScore: number;
  /** Active flags: BURST, DRAINAGE, DEVIATION. */
  flags: string[];
}

export function freshAnomalyState(now: number): AnomalyState {
  return {
    txSizeSum: 0n,
    txSizeSqSum: 0n,
    txCount: 0,
    txSinceBaseline: 0,
    lastBaselineUpdate: now,
    burstWindowStart: 0,
    burstCount: 0,
    drainageAmount: 0n,
    drainageAddress: null,
    drainageTxCount: 0,
    drainageWindowStart: 0,
    anomalyScore: 0,
    flags: [],
  };
}

/** Burst: `threshold` transfers already seen inside the window. */
export function detectBurst(state: AnomalyState, now: number, config: AnomalyConfig): boolean {
  if (state.burstWindowStart === 0) return false;
  if (now - state.burstWindowStart > config.burstWindowMs) return false;
  return state.burstCount >= config.burstThreshold;
}

/**
 * Drainage: the payment would push one destination above the concentration
 * threshold. Requires at least two prior payments to that destination so a
 * single legitimate large payment is not mistaken for a drain.
 */
export function detectDrainage(
  state: AnomalyState,
  amount: bigint,
  to: string,
  dailyLimit: bigint,
  config: AnomalyConfig,
): boolean {
  if (state.drainageAddress !== to || state.drainageTxCount < 2) return false;
  const threshold = (dailyLimit * BigInt(config.drainageThresholdBps)) / 10_000n;
  return state.drainageAmount + amount > threshold;
}

/** Deviation: a transfer more than `deviationSigma` times the baseline mean. */
export function detectDeviation(state: AnomalyState, amount: bigint, config: AnomalyConfig): boolean {
  if (state.txCount < 10) return false;
  const mean = state.txSizeSum / BigInt(state.txCount);
  return mean > 0n && amount > mean * BigInt(config.deviationSigma);
}

export function standardDeviation(state: AnomalyState): bigint {
  if (state.txCount === 0) return 0n;
  const n = BigInt(state.txCount);
  const mean = state.txSizeSum / n;
  const variance = state.txSizeSqSum / n - mean * mean;
  if (variance <= 0n) return 0n;
  // Integer square root, enough for display and threshold checks.
  let x = variance;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + variance / x) / 2n;
  }
  return x;
}

/** Fold one transfer into the baseline, burst and drainage state. */
export function recordSpend(
  state: AnomalyState,
  amount: bigint,
  to: string,
  now: number,
  config: AnomalyConfig,
): AnomalyState {
  const next: AnomalyState = { ...state, flags: [...state.flags] };

  if (next.burstWindowStart === 0 || now - next.burstWindowStart > config.burstWindowMs) {
    next.burstWindowStart = now;
    next.burstCount = 1;
  } else {
    next.burstCount += 1;
  }

  if (next.drainageWindowStart === 0 || now - next.drainageWindowStart >= 86_400_000) {
    next.drainageWindowStart = now;
    next.drainageAddress = to;
    next.drainageAmount = amount;
    next.drainageTxCount = 1;
  } else if (next.drainageAddress === to) {
    next.drainageAmount += amount;
    next.drainageTxCount += 1;
  } else if (amount > next.drainageAmount) {
    next.drainageAddress = to;
    next.drainageAmount = amount;
    next.drainageTxCount = 1;
  }

  next.txSizeSum += amount;
  next.txSizeSqSum += amount * amount;
  next.txCount += 1;
  next.txSinceBaseline += 1;
  if (next.txSinceBaseline >= config.baselineUpdateInterval) {
    next.txSinceBaseline = 0;
    next.lastBaselineUpdate = now;
  }
  return next;
}

/** Recompute the score from the active flags, capped at 100. */
export function scoreAnomaly(state: AnomalyState, config: AnomalyConfig): { score: number; flags: string[] } {
  const flags = [...state.flags];
  let score = state.anomalyScore;
  if (detectBurst(state, state.burstWindowStart, config) && !flags.includes('BURST')) {
    score = Math.min(100, score + 30);
    flags.push('BURST');
  }
  if (flags.includes('BURST') && score < 30) score = 30;
  if (flags.includes('DRAINAGE') && score < 25) score = 25;
  return { score: Math.max(0, Math.min(100, score)), flags };
}
