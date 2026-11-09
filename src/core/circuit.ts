/**
 * Circuit breaker state machine, mirrored from the contract.
 *
 * Level 0 normal; 1 limits reduced to 10% for a fixed duration; 2 agent paused
 * until the owner acts; 3 vault paused; 4 emergency freeze. Levels 1 expire on
 * their own; 2-4 require a human. Automatic escalation is the point: a stolen
 * key should hit a wall without waiting for someone to notice.
 */

export type BreakerLevel = 0 | 1 | 2 | 3 | 4;

export interface CircuitBreakerState {
  level: BreakerLevel;
  triggeredAt: number;
  expiresAt: number;
  reason: string;
}

export const LIMIT_REDUCTION_FRACTION = 0.1;

export function normalState(): CircuitBreakerState {
  return { level: 0, triggeredAt: 0, expiresAt: 0, reason: '' };
}

export function triggerLevel1(state: CircuitBreakerState, reason: string, durationMs: number, now = Date.now()): CircuitBreakerState {
  return { level: Math.max(state.level, 1) as BreakerLevel, triggeredAt: now, expiresAt: now + durationMs, reason };
}

export function triggerLevel2(state: CircuitBreakerState, reason: string, now = Date.now()): CircuitBreakerState {
  return { level: Math.max(state.level, 2) as BreakerLevel, triggeredAt: now, expiresAt: 0, reason };
}

export function triggerLevel3(state: CircuitBreakerState, reason: string, now = Date.now()): CircuitBreakerState {
  return { level: Math.max(state.level, 3) as BreakerLevel, triggeredAt: now, expiresAt: 0, reason };
}

export function triggerLevel4(state: CircuitBreakerState, reason: string, now = Date.now()): CircuitBreakerState {
  return { level: 4, triggeredAt: now, expiresAt: 0, reason };
}

export function isExpired(state: CircuitBreakerState, now: number): boolean {
  return state.level > 0 && state.expiresAt > 0 && now >= state.expiresAt;
}

/** Effective level, accounting for level-1 expiry. */
export function currentLevel(state: CircuitBreakerState, now: number): BreakerLevel {
  return isExpired(state, now) ? 0 : state.level;
}

export function shouldReduceLimits(state: CircuitBreakerState, now: number): boolean {
  return currentLevel(state, now) === 1;
}

export function shouldPauseAgent(state: CircuitBreakerState, now: number): boolean {
  return currentLevel(state, now) >= 2;
}

export function shouldFreezeVault(state: CircuitBreakerState, now: number): boolean {
  return currentLevel(state, now) >= 4;
}

export function limitFraction(state: CircuitBreakerState, now: number): number {
  return shouldReduceLimits(state, now) ? LIMIT_REDUCTION_FRACTION : 1.0;
}
