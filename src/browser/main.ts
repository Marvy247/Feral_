/**
 * The browser demo entry point.
 *
 * This module is the product, not a mock of it: it imports the same engine,
 * the same guard and the same scenario catalogue that the CLI, the dashboard
 * server and the Rust contract are built from, and `scripts/build-demo.ts`
 * compiles all of it into one static page.
 *
 * A judge who opens `docs/demo/index.html` therefore runs the real
 * `FeralGuard` - the same `evaluate()`, the same reputation arithmetic, the
 * same anomaly detector, the same hash-chained audit log - in their browser,
 * with no install, no wallet, no network and no API key.
 *
 * The page is fed from two places:
 *
 *   - `buildDemo()` computes the 52-wall catalogue once and returns a plain
 *     JSON payload the page renders;
 *   - `createLiveSession()` hands the page a live guard it can push actions
 *     through, so the numbers on screen move when you click.
 */
import { readFileSync } from 'node:fs';
import { REASON, type ActionRequest, type CheckResult, type Decision } from '../core/engine.ts';
import { FeralGuard } from '../core/service.ts';
import { CATALOGUE, LAB, PRICES, START, runScenario, type ScenarioResult } from '../demo/scenarios.ts';

export interface DemoScenario extends ScenarioResult {
  description: string;
}

export interface DemoAgent {
  account: string;
  tier: string;
  reputation: number;
  limits: { perTx: string | null; daily: string | null; monthly: string | null };
}

export interface DemoPayload {
  product: {
    name: string;
    tagline: string;
    policyName: string;
    policyHash: string;
    owner: string;
  };
  policy: {
    agents: DemoAgent[];
    aggregate: { asset: string; daily: string; monthly: string }[];
    counterparties: { mode: string; allow: string[]; deny: string[] };
    approvals: { thresholdUsd: number; approvers: string[]; quorum: number };
    velocity: { maxTxPerHour: number; minIntervalSeconds: number };
    intents: { venues: string[]; maxSlippageBps: number; allowedDestinations: string[] };
  };
  scenarios: DemoScenario[];
  totals: { count: number; denied: number; escalated: number; allowed: number; failed: number };
  categories: { name: string; count: number; denied: number }[];
  capability: {
    offChainReasonCodes: number;
    onChainReasonCodes: string[];
    contractLines: number;
    rustTests: number;
    scenarioCount: number;
  };
  audit: { head: string; records: number; ok: boolean };
}

/** Reason codes the Rust vault enforces, read from the contract at build time. */
interface ContractFacts {
  reasonCodes: string[];
  lines: number;
  tests: number;
}

function contractFacts(): ContractFacts {
  try {
    const raw = readFileSync('/contract/contract-summary.json', 'utf8');
    const parsed = JSON.parse(raw) as ContractFacts;
    return parsed;
  } catch {
    return { reasonCodes: [], lines: 0, tests: 0 };
  }
}

/** Compute every scenario against a fresh guard, in order. */
export async function buildDemo(): Promise<DemoPayload> {
  const scenarios: DemoScenario[] = [];
  for (const entry of CATALOGUE) {
    const result = await runScenario(entry);
    scenarios.push({ ...result, description: entry.description });
  }

  const denied = scenarios.filter((s) => s.verdict === 'deny').length;
  const escalated = scenarios.filter((s) => s.verdict === 'require_approval').length;
  const allowed = scenarios.filter((s) => s.verdict === 'allow').length;
  const failed = scenarios.filter((s) => !s.passed).length;

  const categories = [...new Set(scenarios.map((s) => s.category))].map((name) => ({
    name,
    count: scenarios.filter((s) => s.category === name).length,
    denied: scenarios.filter((s) => s.category === name && s.verdict === 'deny').length,
  }));

  const { guard } = liveGuard();
  const compiled = guard.compiled;
  const agents: DemoAgent[] = guard.getAgents().map((agent) => {
    const limits = guard.getEffectiveLimits(agent.account);
    return {
      account: agent.account,
      tier: agent.tier,
      reputation: agent.reputation,
      limits: {
        perTx: limits.assets.USDC?.perTx ?? null,
        daily: limits.assets.USDC?.daily ?? null,
        monthly: limits.assets.USDC?.monthly ?? null,
      },
    };
  });

  const facts = contractFacts();
  const aggregate = ['NEAR', 'USDC'].map((asset) => ({
    asset,
    daily: guard.getAggregateRemaining(asset, 'day').toString(),
    monthly: guard.getAggregateRemaining(asset, 'month').toString(),
  }));

  const doc = compiled.doc;
  return {
    product: {
      name: 'Feral',
      tagline: 'Policy-enforced custody for autonomous agents on NEAR.',
      policyName: doc.name,
      policyHash: compiled.hash,
      owner: doc.owner,
    },
    policy: {
      agents,
      aggregate,
      counterparties: {
        mode: doc.counterparties?.mode ?? 'strict',
        allow: doc.counterparties?.allow ?? [],
        deny: doc.counterparties?.deny ?? [],
      },
      approvals: {
        thresholdUsd: doc.approvals?.thresholdUsd ?? 0,
        approvers: doc.approvals?.approvers ?? [],
        quorum: doc.approvals?.quorum ?? 1,
      },
      velocity: {
        maxTxPerHour: doc.velocity?.maxTxPerHour ?? 0,
        minIntervalSeconds: doc.velocity?.minIntervalSeconds ?? 0,
      },
      intents: {
        venues: doc.intents?.venues ?? [],
        maxSlippageBps: doc.intents?.maxSlippageBps ?? 0,
        allowedDestinations: doc.intents?.allowedDestinations ?? [],
      },
    },
    scenarios,
    totals: { count: scenarios.length, denied, escalated, allowed, failed },
    categories,
    capability: {
      offChainReasonCodes: Object.keys(REASON).length,
      onChainReasonCodes: facts.reasonCodes,
      contractLines: facts.lines,
      rustTests: facts.tests,
      scenarioCount: scenarios.length,
    },
    audit: { head: guard.auditLog.head(), records: guard.auditLog.length, ok: guard.auditLog.verify().ok },
  };
}

// ------------------------------------------------------------ live session ----

export interface LiveState {
  reputation: number;
  breakerLevel: number;
  anomalyScore: number;
  dailyRemaining: string;
  pendingApprovals: { id: string; amount: string; to: string; expiresAt: string }[];
  auditHead: string;
  auditRecords: number;
  auditOk: boolean;
  verdict: string;
  codes: string[];
  detail: string;
  checks: CheckResult[];
  history: { id: number; label: string; verdict: string; codes: string[]; at: string }[];
}

export interface LiveSession {
  state(): LiveState;
  submit(action: Partial<ActionRequest> & { label: string }): Promise<LiveState>;
  approve(approvalId: string): Promise<LiveState>;
  reset(): LiveState;
}

/** A guard with a controllable clock, so the demo is deterministic. */
function liveGuard(): { guard: FeralGuard; clock: { t: number } } {
  const clock = { t: START };
  const guard = FeralGuard.create({
    policyText: LAB,
    clock: () => clock.t,
    prices: PRICES,
  });
  return { guard, clock };
}

export function createLiveSession(): LiveSession {
  const { guard, clock } = liveGuard();
  const history: LiveState['history'] = [];
  let last: Decision | undefined;

  const snapshot = (): LiveState => {
    const agent = guard.getAgent('argo.near');
    const verification = guard.auditLog.verify();
    return {
      reputation: agent?.reputation ?? 100,
      breakerLevel: agent?.circuitBreaker ?? 0,
      anomalyScore: guard.getAnomalyScore('argo.near'),
      dailyRemaining: guard.getAggregateRemaining('USDC', 'day').toString(),
      pendingApprovals: guard.pendingApprovals.map((a) => ({
        id: a.id,
        amount: a.action.amount,
        to: a.action.to ?? '',
        expiresAt: new Date(a.expiresAt).toISOString(),
      })),
      auditHead: guard.auditLog.head(),
      auditRecords: guard.auditLog.length,
      auditOk: verification.ok,
      verdict: last?.verdict ?? 'idle',
      codes: last?.reasons.map((r) => r.code as string) ?? [],
      detail: last?.reasons.map((r) => r.message).join(' | ') ?? '',
      checks: last?.checks ?? [],
      history: [...history],
    };
  };

  return {
    state: snapshot,
    async submit(action) {
      clock.t += 6000;
      const { label, ...rest } = action;
      const full: ActionRequest = {
        id: `live_${clock.t}_${history.length}`,
        kind: 'ft.transfer',
        actor: 'argo.near',
        asset: 'USDC',
        amount: '5',
        to: 'compute.near',
        ...rest,
      } as ActionRequest;
      const { decision } = await guard.submit(full);
      last = decision;
      history.unshift({
        id: history.length + 1,
        label,
        verdict: decision.verdict,
        codes: decision.reasons.map((r) => r.code as string),
        at: new Date(clock.t).toISOString(),
      });
      return snapshot();
    },
    async approve(approvalId) {
      const outcome = await guard.approve(approvalId, 'alice.near');
      if (outcome.decision) last = outcome.decision;
      history.unshift({
        id: history.length + 1,
        label: `approve ${approvalId.slice(0, 8)}`,
        verdict: outcome.status,
        codes: outcome.decision?.reasons.map((r) => r.code as string) ?? [],
        at: new Date(clock.t).toISOString(),
      });
      return snapshot();
    },
    reset() {
      history.length = 0;
      last = undefined;
      return snapshot();
    },
  };
}

export default buildDemo();
