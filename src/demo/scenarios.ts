/**
 * The shared scenario catalogue: 52 attempts an agent could make and the wall
 * each one hits.
 *
 * One source of truth for:
 *  - the adversarial test suite (asserts every verdict),
 *  - `feral attack` (renders the table),
 *  - the dashboard's attack simulator.
 *
 * A scenario cannot be added without an expected verdict. Governance scenarios
 * use `run` because their outcome is a state transition (cancelled / frozen /
 * thawed), not an ActionRequest verdict.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, type PolicyDoc } from '../core/policy.ts';
import { FeralGuard } from '../core/service.ts';
import type { ActionRequest } from '../core/engine.ts';
import { sha256Hex } from '../core/canonical.ts';

export const START = Date.parse('2026-11-02T12:00:00Z');
export const PRICES = { NEAR: 2_450_000n, USDC: 1_000_000n, USDT: 1_000_000n };

const policyPath = join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
const baseDoc = loadPolicy(readFileSync(policyPath, 'utf8')).doc;

export function policyText(mutate: (doc: PolicyDoc) => void = () => {}): string {
  const doc = structuredClone(baseDoc);
  mutate(doc);
  return JSON.stringify(doc);
}

/** The shipped walls, minus the two advisory risk escalations. */
export const LAB = policyText((doc) => {
  doc.risk = {};
});

/** Tighter aggregate cap, so a two-agent coordination attempt can exhaust it. */
export const AGGREGATE_SMALL = policyText((doc) => {
  doc.risk = {};
  if (doc.limits.aggregate?.daily) doc.limits.aggregate.daily.USDC = 150;
});

/** argo.near must present a TEE attestation proof. */
export const ATTESTATION = policyText((doc) => {
  doc.risk = {};
  if (doc.agents?.[0]) doc.agents[0].attestationHash = sha256Hex('proof');
});

export const PAUSED = policyText((doc) => {
  doc.risk = {};
  doc.paused = true;
});

export const EXPIRED = policyText((doc) => {
  doc.risk = {};
  doc.expiresAt = '2026-11-01T00:00:00Z';
});

/** The MPC-derived address of argo.near on path "ethereum-1", pinned in the policy. */
export const PINNED_DESTINATION = '0x583ddbf02324f75c3963c45686d52afaf2368c2f';
export const ATTACKER_DESTINATION = '0xdeadbeef00000000000000000000000000000000';

export type Expect = 'allow' | 'deny' | 'require_approval' | 'cancelled' | 'frozen' | 'thawed';

export const CATEGORIES = ['basic', 'multi-agent', 'reputation', 'anomaly', 'circuit', 'governance', 'attestation'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Scenario {
  id: number;
  name: string;
  description: string;
  /** The wall this attempt is supposed to hit, in words. */
  wall: string;
  category: Category;
  agent: string;
  action?: Partial<ActionRequest>;
  policy?: keyof typeof policyNames;
  setup?: (guard: FeralGuard, clock: { t: number }) => Promise<void> | void;
  run?: (guard: FeralGuard, clock: { t: number }) => Promise<{ verdict: string; codes: string[]; detail?: string }>;
  expect: Expect;
  expectCodes?: string[];
  executor?: 'fail';
}

const policyNames = {
  lab: LAB,
  aggregateSmall: AGGREGATE_SMALL,
  attestation: ATTESTATION,
  paused: PAUSED,
  expired: EXPIRED,
};

const usdc = (amount: string, to: string, actor = 'argo.near'): Partial<ActionRequest> => ({
  kind: 'ft.transfer',
  actor,
  asset: 'USDC',
  amount,
  to,
});

const swap = (overrides: Record<string, unknown> = {}): Partial<ActionRequest> => ({
  kind: 'intent.swap',
  actor: 'argo.near',
  asset: 'NEAR',
  amount: '1',
  quote: {
    originAsset: 'NEAR',
    destinationAddress: PINNED_DESTINATION,
    slippageBps: 50,
    expiresAt: '2026-11-02T12:05:00Z',
  },
  ...overrides,
});

let setupCounter = 0;

/** Submit one action through the guard, advancing time by `gapMs` first. */
async function pay(guard: FeralGuard, clock: { t: number }, action: Partial<ActionRequest>, gapMs = 6000): Promise<void> {
  clock.t += gapMs;
  setupCounter += 1;
  const full: ActionRequest = {
    id: `setup_${setupCounter}`,
    kind: 'ft.transfer',
    actor: 'argo.near',
    asset: 'USDC',
    amount: '1',
    to: 'compute.near',
    ...action,
  };
  await guard.submit(full);
}

async function denyNTimes(guard: FeralGuard, clock: { t: number }, n: number, actor = 'argo.near'): Promise<void> {
  for (let i = 0; i < n; i++) {
    clock.t += 6000;
    await guard.submit({
      id: `denial_${i}_${clock.t}`,
      kind: 'ft.transfer',
      actor,
      asset: 'USDC',
      amount: '26',
      to: 'compute.near',
    });
  }
}

export const SCENARIOS: Scenario[] = [
  // ---- basic: the original Feral walls -------------------------------------
  {
    id: 1, name: 'Overspend one transfer (26 USDC)', wall: 'per-transaction cap', category: 'basic', agent: 'argo.near',
    description: 'The agent asks for one more USDC than the per-tx limit allows.',
    action: usdc('26', 'compute.near'), expect: 'deny', expectCodes: ['PER_TX_LIMIT'],
  },
  {
    id: 2, name: 'Overspend native (1000 NEAR)', wall: 'per-transaction cap', category: 'basic', agent: 'argo.near',
    description: 'Three orders of magnitude above the NEAR per-tx cap.',
    action: { kind: 'near.transfer', actor: 'argo.near', asset: 'NEAR', amount: '1000', to: 'compute.near' },
    expect: 'deny', expectCodes: ['PER_TX_LIMIT'],
  },
  {
    id: 3, name: 'Extra decimals (5.0000001 USDC)', wall: 'exact amount parsing', category: 'basic', agent: 'argo.near',
    description: 'A hidden fraction that a rounding engine would swallow.',
    action: usdc('5.0000001', 'compute.near'), expect: 'deny', expectCodes: ['INVALID_AMOUNT'],
  },
  {
    id: 4, name: 'Negative amount', wall: 'amount validation', category: 'basic', agent: 'argo.near',
    description: 'A negative transfer, hoping to add budget.',
    action: usdc('-5', 'compute.near'), expect: 'deny', expectCodes: ['INVALID_AMOUNT'],
  },
  {
    id: 5, name: 'Zero amount', wall: 'amount validation', category: 'basic', agent: 'argo.near',
    description: 'A zero-value transfer used as a probe.',
    action: usdc('0', 'compute.near'), expect: 'deny', expectCodes: ['NON_POSITIVE_AMOUNT'],
  },
  {
    id: 6, name: 'Scientific notation (1e5)', wall: 'exact amount parsing', category: 'basic', agent: 'argo.near',
    description: 'Scientific notation that some parsers accept and others truncate.',
    action: usdc('1e5', 'compute.near'), expect: 'deny', expectCodes: ['INVALID_AMOUNT'],
  },
  {
    id: 7, name: 'Wrong-case account id', wall: 'account id validation', category: 'basic', agent: 'argo.near',
    description: 'NEAR account ids are lowercase; Compute.NEAR is not the vendor.',
    action: usdc('5', 'Compute.NEAR'), expect: 'deny', expectCodes: ['INVALID_RECIPIENT'],
  },
  {
    id: 8, name: 'Trailing-dot account id', wall: 'account id validation', category: 'basic', agent: 'argo.near',
    description: 'A trailing dot changes the account id, not the intent.',
    action: usdc('5', 'compute.near.'), expect: 'deny', expectCodes: ['INVALID_RECIPIENT'],
  },
  {
    id: 9, name: 'Empty action id', wall: 'request shape', category: 'basic', agent: 'argo.near',
    description: 'Without an id there is no replay protection.',
    action: { ...usdc('5', 'compute.near'), id: '' }, expect: 'deny', expectCodes: ['INVALID_ACTION'],
  },
  {
    id: 10, name: 'Invented action kind', wall: 'action allow list', category: 'basic', agent: 'argo.near',
    description: 'A kind the policy has never heard of.',
    action: { ...usdc('5', 'compute.near'), kind: 'bridge.teleport' as never }, expect: 'deny', expectCodes: ['INVALID_ACTION'],
  },
  {
    id: 11, name: 'Unregistered asset', wall: 'deny-by-default asset registry', category: 'basic', agent: 'argo.near',
    description: 'An asset with no limit applies to no limit.',
    action: { kind: 'ft.transfer', actor: 'argo.near', asset: 'DOGE', amount: '10', to: 'compute.near' },
    expect: 'deny', expectCodes: ['UNKNOWN_ASSET'],
  },
  {
    id: 12, name: 'Pay a stranger', wall: 'counterparty allow list', category: 'basic', agent: 'argo.near',
    description: 'Strict mode: only listed vendors are reachable.',
    action: usdc('5', 'attacker.near'), expect: 'deny', expectCodes: ['RECIPIENT_NOT_ALLOWED'],
  },
  {
    id: 13, name: 'Pay the deny-listed drainer', wall: 'counterparty deny list', category: 'basic', agent: 'argo.near',
    description: 'Explicit deny beats any allow-list accident.',
    action: usdc('5', 'drainer.near'), expect: 'deny', expectCodes: ['RECIPIENT_DENIED'],
  },
  {
    id: 14, name: 'Cyrillic homoglyph account', wall: 'account id validation', category: 'basic', agent: 'argo.near',
    description: 'A lookalike character cannot pass for the vendor.',
    action: usdc('5', 'c\u043empute.near'), expect: 'deny', expectCodes: ['INVALID_RECIPIENT'],
  },
  {
    id: 15, name: 'Agent claims owner identity', wall: 'identity binding', category: 'basic', agent: 'alice.near',
    description: 'The actor is the owner, not a registered agent.',
    action: usdc('5', 'compute.near', 'alice.near'), expect: 'deny', expectCodes: ['ACTOR_NOT_AGENT'],
  },
  {
    id: 16, name: 'Add a new access key', wall: 'action kind allow list', category: 'basic', agent: 'argo.near',
    description: 'Adding a key would escape every limit.',
    action: { kind: 'key.add', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
    expect: 'deny', expectCodes: ['ACTION_NOT_ALLOWED'],
  },
  {
    id: 17, name: 'Delete the owner key', wall: 'action kind allow list', category: 'basic', agent: 'argo.near',
    description: 'Deleting a key is never a spending action.',
    action: { kind: 'key.delete', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
    expect: 'deny', expectCodes: ['ACTION_NOT_ALLOWED'],
  },
  {
    id: 18, name: 'Arbitrary contract call', wall: 'action kind allow list', category: 'basic', agent: 'argo.near',
    description: 'An arbitrary call could move anything.',
    action: { kind: 'contract.call', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
    expect: 'deny', expectCodes: ['ACTION_NOT_ALLOWED'],
  },
  {
    id: 19, name: 'Swap with no quote', wall: 'quote validation', category: 'basic', agent: 'argo.near',
    description: 'No quote means venue, slippage, expiry and destination are unverifiable.',
    action: { kind: 'intent.swap', actor: 'argo.near', asset: 'NEAR', amount: '1' },
    expect: 'deny', expectCodes: ['MISSING_QUOTE'],
  },
  {
    id: 20, name: 'Swap with 5% slippage', wall: 'slippage ceiling', category: 'basic', agent: 'argo.near',
    description: 'Five percent is fifty times the 100 bps ceiling.',
    action: swap({ quote: { originAsset: 'NEAR', destinationAddress: PINNED_DESTINATION, slippageBps: 500 } }),
    expect: 'deny', expectCodes: ['SLIPPAGE_TOO_HIGH'],
  },
  {
    id: 21, name: 'Swap with redirected output', wall: 'destination pinning', category: 'basic', agent: 'argo.near',
    description: 'A valid quote with the output address swapped for the attacker.',
    action: swap({ quote: { originAsset: 'NEAR', destinationAddress: ATTACKER_DESTINATION, slippageBps: 50 } }),
    expect: 'deny', expectCodes: ['DESTINATION_NOT_ALLOWED'],
  },
  {
    id: 22, name: 'Unknown swap venue', wall: 'venue allow list', category: 'basic', agent: 'argo.near',
    description: 'A venue the policy never approved.',
    action: swap({ venue: 'sketchy-dex' }), expect: 'deny', expectCodes: ['VENUE_NOT_ALLOWED'],
  },
  {
    id: 23, name: 'Expired quote', wall: 'quote expiry', category: 'basic', agent: 'argo.near',
    description: 'A quote from before the demo started.',
    action: swap({ quote: { originAsset: 'NEAR', destinationAddress: PINNED_DESTINATION, slippageBps: 50, expiresAt: '2026-11-02T11:59:00Z' } }),
    expect: 'deny', expectCodes: ['QUOTE_EXPIRED'],
  },
  {
    id: 24, name: 'Quote asset mismatch', wall: 'origin asset check', category: 'basic', agent: 'argo.near',
    description: 'The quote spends USDC while the action claims NEAR.',
    action: swap({ quote: { originAsset: 'USDC', destinationAddress: PINNED_DESTINATION, slippageBps: 50 } }),
    expect: 'deny', expectCodes: ['ORIGIN_ASSET_MISMATCH'],
  },
  {
    id: 25, name: 'Payment above approval threshold', wall: 'approval threshold', category: 'basic', agent: 'argo.near',
    description: 'Twenty USDC is within the per-tx cap but above the $10 human line.',
    action: usdc('20', 'compute.near'), expect: 'require_approval', expectCodes: ['APPROVAL_REQUIRED'],
  },
  {
    id: 26, name: 'Legitimate API payment', wall: 'none - allowed', category: 'basic', agent: 'argo.near',
    description: 'Five USDC to an allow-listed vendor, below every threshold.',
    action: usdc('5', 'compute.near'), expect: 'allow',
  },
  {
    id: 27, name: 'Legitimate swap', wall: 'none - allowed', category: 'basic', agent: 'argo.near',
    description: 'One NEAR on the allowed venue, to the pinned address, quote fresh.',
    action: swap(), expect: 'allow',
  },
  {
    id: 28, name: 'Anything while paused', wall: 'owner pause switch', category: 'basic', agent: 'argo.near',
    description: 'The owner paused the policy.',
    action: usdc('5', 'compute.near'), policy: 'paused', expect: 'deny', expectCodes: ['POLICY_PAUSED'],
  },
  {
    id: 29, name: 'Anything after expiry', wall: 'policy expiry', category: 'basic', agent: 'argo.near',
    description: 'The policy validity window closed yesterday.',
    action: usdc('5', 'compute.near'), policy: 'expired', expect: 'deny', expectCodes: ['POLICY_EXPIRED'],
  },

  // ---- multi-agent --------------------------------------------------------
  {
    id: 30, name: 'Agent A drains daily, B has budget', wall: 'aggregate vault limit', category: 'multi-agent', agent: 'scout.near',
    description: 'argo spends its own daily cap; scout still has agent budget but the vault does not.',
    policy: 'aggregateSmall',
    setup: async (guard, clock) => {
      await pay(guard, clock, usdc('25', 'compute.near'));
      await pay(guard, clock, usdc('25', 'api.data-market.near'));
      await pay(guard, clock, usdc('25', 'storage.near'));
      await pay(guard, clock, usdc('25', 'vendor.near'));
    },
    action: usdc('60', 'compute.near', 'scout.near'), expect: 'deny', expectCodes: ['AGGREGATE_DAILY_LIMIT'],
  },
  {
    id: 31, name: 'Two agents pay the same stranger', wall: 'counterparty allow list', category: 'multi-agent', agent: 'scout.near',
    description: 'Coordinated attempts to an unknown address are both refused by the strict list.',
    setup: async (guard, clock) => {
      await pay(guard, clock, usdc('5', 'unknown-payee.near'));
    },
    action: usdc('5', 'unknown-payee.near', 'scout.near'), expect: 'deny', expectCodes: ['RECIPIENT_NOT_ALLOWED'],
  },

  // ---- anomaly ------------------------------------------------------------
  {
    id: 32, name: 'Six rapid transactions from one agent', wall: 'burst anomaly', category: 'anomaly', agent: 'argo.near',
    description: 'Five transfers inside the burst window, then a sixth.',
    setup: async (guard, clock) => {
      for (let i = 0; i < 5; i++) await pay(guard, clock, usdc('1', 'compute.near'));
    },
    action: usdc('1', 'compute.near'), expect: 'deny', expectCodes: ['ANOMALY_BURST'],
  },
  {
    id: 33, name: 'Five payments to one new address', wall: 'drainage anomaly', category: 'anomaly', agent: 'argo.near',
    description: 'Half the daily cap concentrated on one destination, then more.',
    setup: async (guard, clock) => {
      for (let i = 0; i < 5; i++) await pay(guard, clock, usdc('10', 'vendor.near'), 61_000);
    },
    action: usdc('10', 'vendor.near'), expect: 'deny', expectCodes: ['ANOMALY_DRAINAGE'],
  },
  {
    id: 34, name: 'Transaction 10x the baseline', wall: 'deviation anomaly', category: 'anomaly', agent: 'argo.near',
    description: 'Ten small payments build a baseline; the eleventh is ten times larger.',
    setup: async (guard, clock) => {
      // 15 minutes apart so the hourly velocity cap does not fire first: this
      // scenario is about transaction size, not rate.
      for (let i = 0; i < 10; i++) await pay(guard, clock, usdc('1', 'compute.near'), 900_000);
    },
    action: usdc('10', 'compute.near'), expect: 'deny', expectCodes: ['ANOMALY_DEVIATION'],
  },

  // ---- reputation ---------------------------------------------------------
  {
    id: 35, name: 'Agent at reputation 0 tries to spend', wall: 'reputation freeze', category: 'reputation', agent: 'argo.near',
    description: 'Ten denials drop reputation to zero; the agent is frozen.',
    setup: async (guard, clock) => { await denyNTimes(guard, clock, 10); },
    action: usdc('5', 'compute.near'), expect: 'deny', expectCodes: ['REPUTATION_FROZEN'],
  },
  {
    id: 36, name: 'Reputation 50, effective limit is half', wall: 'reputation-adjusted limit', category: 'reputation', agent: 'argo.near',
    description: 'Five denials halve the effective per-tx cap to 12 USDC; the agent tries 15.',
    setup: async (guard, clock) => { await denyNTimes(guard, clock, 5); },
    action: usdc('15', 'compute.near'), expect: 'deny', expectCodes: ['PER_TX_LIMIT'],
  },
  {
    id: 37, name: 'Circuit breaker level 1 active', wall: 'breaker limit reduction', category: 'circuit', agent: 'argo.near',
    description: 'Level 1 reduces every limit to 10%; a normal-sized payment is now over the wall.',
    setup: (guard) => { guard.triggerCircuitBreaker('argo.near', 1, 'test: level 1'); },
    action: usdc('3', 'compute.near'), expect: 'deny', expectCodes: ['PER_TX_LIMIT'],
  },
  {
    id: 38, name: 'Spend during emergency freeze', wall: 'vault freeze', category: 'circuit', agent: 'argo.near',
    description: 'A guardian froze the vault; no agent can spend.',
    setup: (guard) => { guard.emergencyFreeze('dave.near'); },
    action: usdc('1', 'compute.near'), expect: 'deny', expectCodes: ['EMERGENCY_FREEZE'],
  },
  {
    id: 51, name: 'Reputation recovers after 30 clean days', wall: 'none - recovery allowed', category: 'reputation', agent: 'argo.near',
    description: 'Five denials, then thirty clean days: the next clean spend restores 20 points.',
    setup: async (guard, clock) => {
      await denyNTimes(guard, clock, 5);
      clock.t += 30 * 86_400_000;
    },
    action: usdc('5', 'compute.near'), expect: 'allow',
  },
  {
    id: 52, name: 'Reputation 40, small spend within effective limits', wall: 'none - allowed', category: 'reputation', agent: 'argo.near',
    description: 'Six denials leave reputation 40; 5 USDC is within the adjusted 10 USDC per-tx cap.',
    setup: async (guard, clock) => { await denyNTimes(guard, clock, 6); },
    action: usdc('5', 'compute.near'), expect: 'allow',
  },

  // ---- attestation --------------------------------------------------------
  {
    id: 39, name: 'Missing TEE attestation proof', wall: 'attestation required', category: 'attestation', agent: 'argo.near',
    description: 'The agent has a registered binary hash but sends no proof.',
    policy: 'attestation',
    action: usdc('5', 'compute.near'), expect: 'deny', expectCodes: ['ATTESTATION_REQUIRED'],
  },
  {
    id: 40, name: 'Wrong TEE attestation hash', wall: 'attestation mismatch', category: 'attestation', agent: 'argo.near',
    description: 'A forged proof does not hash to the registered value.',
    policy: 'attestation',
    action: { ...usdc('5', 'compute.near'), attestationProof: 'forged' },
    expect: 'deny', expectCodes: ['ATTESTATION_MISMATCH'],
  },

  // ---- governance ---------------------------------------------------------
  {
    id: 41, name: 'Timelocked withdrawal before delay', wall: 'timelock not elapsed', category: 'governance', agent: 'alice.near',
    description: 'The owner proposes a withdrawal and tries to execute immediately.',
    run: async (guard) => {
      const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: 200 });
      try {
        guard.executeTimelock(id);
        return { verdict: 'allow', codes: [] };
      } catch (err) {
        return { verdict: 'deny', codes: [(err as Error).message.includes('not yet executable') ? 'TIMELOCK_NOT_EXECUTABLE' : 'TIMELOCK_ERROR'] };
      }
    },
    expect: 'deny', expectCodes: ['TIMELOCK_NOT_EXECUTABLE'],
  },
  {
    id: 42, name: 'Watcher cancels a suspicious timelock', wall: 'governance watcher cancellation', category: 'governance', agent: 'dave.near',
    description: 'A watcher cancels a withdrawal before it can execute.',
    run: async (guard) => {
      const id = guard.proposeTimelock('withdraw', { asset: 'USDC', amount: 200 });
      guard.cancelTimelock(id, 'dave.near');
      return { verdict: 'cancelled', codes: ['TIMELOCK_CANCELLED'] };
    },
    expect: 'cancelled', expectCodes: ['TIMELOCK_CANCELLED'],
  },
  {
    id: 43, name: 'Guardian triggers emergency freeze', wall: 'governance freeze', category: 'governance', agent: 'dave.near',
    description: 'Any guardian can stop the whole vault immediately.',
    run: async (guard) => {
      guard.emergencyFreeze('dave.near');
      const level = guard.getCircuitBreakerLevel().level;
      return { verdict: level === 4 ? 'frozen' : 'allow', codes: level === 4 ? ['EMERGENCY_FREEZE'] : [] };
    },
    expect: 'frozen', expectCodes: ['EMERGENCY_FREEZE'],
  },
  {
    id: 44, name: 'Owner thaws after a freeze', wall: 'governance thaw', category: 'governance', agent: 'alice.near',
    description: 'Only the owner (or multisig) can restore spending.',
    run: async (guard) => {
      guard.emergencyFreeze('dave.near');
      guard.thaw('alice.near');
      const level = guard.getCircuitBreakerLevel().level;
      return { verdict: level === 0 ? 'thawed' : 'frozen', codes: level === 0 ? ['THAWED'] : ['EMERGENCY_FREEZE'] };
    },
    expect: 'thawed', expectCodes: ['THAWED'],
  },
  {
    id: 45, name: 'Agent tries to approve its own payment', wall: 'not an approver', category: 'governance', agent: 'argo.near',
    description: 'The agent that requested a payment cannot co-sign it.',
    run: async (guard, clock) => {
      clock.t += 6000;
      const result = await guard.submit({
        id: 'self_approve', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '20', to: 'compute.near',
      });
      if (!result.approval) return { verdict: 'allow', codes: [] };
      const outcome = await guard.approve(result.approval.id, 'argo.near');
      return { verdict: outcome.status === 'not_an_approver' ? 'deny' : 'allow', codes: [outcome.status === 'not_an_approver' ? 'NOT_AN_APPROVER' : 'APPROVED'] };
    },
    expect: 'deny', expectCodes: ['NOT_AN_APPROVER'],
  },
  {
    id: 46, name: 'Stale approval after a policy change', wall: 'TOCTOU re-check', category: 'governance', agent: 'argo.near',
    description: 'A queued payment is re-checked against the tightened policy at approval time.',
    run: async (guard, clock) => {
      clock.t += 6000;
      const result = await guard.submit({
        id: 'stale_approval', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '20', to: 'compute.near',
      });
      if (!result.approval) return { verdict: 'allow', codes: [] };
      const doc = structuredClone(guard.policyDoc);
      const argo = doc.agents?.find((a) => a.account === 'argo.near');
      if (argo?.limits.perTx) argo.limits.perTx.USDC = 15;
      guard.updatePolicy(JSON.stringify(doc));
      const outcome = await guard.approve(result.approval.id, 'alice.near');
      return {
        verdict: outcome.status === 'recheck_failed' ? 'deny' : 'allow',
        codes: [outcome.status === 'recheck_failed' ? 'APPROVAL_RECHECK_FAILED' : outcome.status],
      };
    },
    expect: 'deny', expectCodes: ['APPROVAL_RECHECK_FAILED'],
  },
  {
    id: 47, name: 'Replay the same action id', wall: 'replay protection', category: 'governance', agent: 'argo.near',
    description: 'An action id is single-use.',
    setup: async (guard, clock) => { await pay(guard, clock, { ...usdc('5', 'compute.near'), id: 'replay_me' }); },
    action: { ...usdc('5', 'compute.near'), id: 'replay_me' }, expect: 'deny', expectCodes: ['REPLAY'],
  },
  {
    id: 48, name: 'Two approvals for the same budget', wall: 'reservation accounting', category: 'governance', agent: 'argo.near',
    description: 'Four pending approvals reserve 80 USDC; a fifth request cannot fit.',
    setup: async (guard, clock) => {
      for (let i = 0; i < 4; i++) {
        clock.t += 6000;
        await guard.submit({
          id: `reserve_${i}`, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '20', to: 'compute.near',
        });
      }
    },
    action: usdc('25', 'compute.near'), expect: 'deny', expectCodes: ['DAILY_LIMIT'],
  },
  {
    id: 49, name: 'Expired approval cannot execute', wall: 'approval expiry', category: 'governance', agent: 'argo.near',
    description: 'The approval window passed while the human was away.',
    run: async (guard, clock) => {
      clock.t += 6000;
      const result = await guard.submit({
        id: 'expiring_approval', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '20', to: 'compute.near',
      });
      if (!result.approval) return { verdict: 'allow', codes: [] };
      clock.t += 1000 * 1000;
      const outcome = await guard.approve(result.approval.id, 'alice.near');
      return { verdict: outcome.status === 'expired' ? 'deny' : 'allow', codes: [outcome.status === 'expired' ? 'APPROVAL_EXPIRED' : outcome.status] };
    },
    expect: 'deny', expectCodes: ['APPROVAL_EXPIRED'],
  },
  {
    id: 50, name: 'Failed executor recorded as denial', wall: 'execution failure', category: 'governance', agent: 'argo.near',
    description: 'The chain rejected the transfer; the decision is recorded as a denial and the budget is not booked.',
    executor: 'fail',
    action: usdc('5', 'compute.near'), expect: 'deny', expectCodes: ['EXECUTION_FAILED'],
  },
];

/** Backwards-compatible alias used by older tooling. */
export const CATALOGUE = SCENARIOS;

export interface ScenarioResult {
  id: number;
  name: string;
  wall: string;
  category: Category;
  expect: Expect;
  verdict: string;
  passed: boolean;
  codes: string[];
  detail: string;
}

export function makeGuard(
  policyName: keyof typeof policyNames = 'lab',
  start = START,
  executor?: 'fail',
): { guard: FeralGuard; clock: { t: number } } {
  const clock = { t: start };
  const guard = FeralGuard.create({
    policyText: policyNames[policyName] ?? LAB,
    clock: () => clock.t,
    prices: PRICES,
    executor:
      executor === 'fail'
        ? () => ({ status: 'failed', detail: 'executor rejected the transfer' })
        : undefined,
  });
  return { guard, clock };
}

/** Run one scenario against a fresh guard; used by tests, `feral attack` and the dashboard. */
export async function runScenario(entry: Scenario): Promise<ScenarioResult> {
  const { guard, clock } = makeGuard(entry.policy ?? 'lab', START, entry.executor);
  if (entry.setup) await entry.setup(guard, clock);

  let verdict: string;
  let codes: string[];
  let detail: string;
  if (entry.run) {
    const outcome = await entry.run(guard, clock);
    verdict = outcome.verdict;
    codes = outcome.codes;
    detail = outcome.detail ?? '';
  } else {
    const action: ActionRequest = {
      id: `scenario_${entry.id}`,
      kind: 'ft.transfer',
      actor: entry.agent,
      asset: 'USDC',
      amount: '5',
      to: 'compute.near',
      ...entry.action,
    };
    const { decision } = await guard.submit(action);
    verdict = decision.verdict;
    codes = decision.reasons.map((r) => r.code as string);
    detail = decision.reasons.map((r) => r.message).join(' | ');
  }

  const codesOk = (entry.expectCodes ?? []).every((c) => codes.includes(c));
  return {
    id: entry.id,
    name: entry.name,
    wall: entry.wall,
    category: entry.category,
    expect: entry.expect,
    verdict,
    passed: verdict === entry.expect && codesOk,
    codes,
    detail,
  };
}

export async function runCatalogue(entries: Scenario[] = SCENARIOS): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const entry of entries) results.push(await runScenario(entry));
  return results;
}
