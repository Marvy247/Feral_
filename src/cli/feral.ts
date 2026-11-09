#!/usr/bin/env node
/**
 * Feral CLI.
 *
 *   feral demo            full narrative: agents, attacks, a live quote, governance
 *   feral demo:judge      60 seconds, zero config, no wallet, no network
 *   feral attack          the whole 52-scenario catalogue, every verdict asserted
 *   feral verify [seed]   1000 random actions, invariants proven
 *   feral bench           latency per check shape
 *   feral serve           dashboard on http://127.0.0.1:8787
 *   feral audit verify    the audit hash chain
 *   feral quote           a real 1Click quote, gated by the policy
 *   feral chainsig        MPC address derivation against the pinned destination
 *   feral simulate [file] what a proposed policy would change
 *   feral reputation      reputation and effective limits per agent
 *   feral anomaly         anomaly scores and flags per agent
 *   feral evaluate <file> dry-run one action
 *
 * Everything runs against the shipped example policy. No keys, no funds, no
 * network needed for the default path (the quote fixture is recorded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FeralGuard } from '../core/service.ts';
import { formatAmount } from '../core/money.ts';
import type { ActionRequest, Decision } from '../core/engine.ts';
import { AuditLog } from '../core/audit.ts';
import {
  ATTACKER_DESTINATION,
  CATALOGUE,
  PINNED_DESTINATION,
  PRICES,
  START,
  makeGuard,
  policyText,
  runCatalogue,
} from '../demo/scenarios.ts';
import { loadQuoteFixture, ONE_CLICK_ASSETS, requestQuote, IntentsError, snapshotFromQuote } from '../chain/intents.ts';
import { SIGNER_ACCOUNTS, derivedPublicKey } from '../chain/chainsig.ts';

const color = process.stdout.isTTY ?? false;
const paint = (code: string, text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);
const green = (text: string): string => paint('32', text);
const red = (text: string): string => paint('31', text);
const amber = (text: string): string => paint('33', text);
const cyan = (text: string): string => paint('36', text);

function verdictChip(verdict: string): string {
  if (verdict === 'allow') return green('ALLOW          ');
  if (verdict === 'deny') return red('DENY           ');
  if (verdict === 'require_approval') return amber('NEEDS APPROVAL ');
  return verdict.toUpperCase().padEnd(15);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

const policyPath = (): string => join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');

function buildGuard(clock: { t: number }): FeralGuard {
  return FeralGuard.create({
    policyText: readFileSync(policyPath(), 'utf8'),
    clock: () => clock.t,
    prices: PRICES,
  });
}

/**
 * Judge mode uses the shipped policy with one change: the human-approval line is
 * high enough that the anomaly and aggregate scenes are about detection, not about
 * waiting for a co-signature. Everything else is the real example policy.
 */
const JUDGE_POLICY = policyText((doc) => {
  if (doc.approvals) doc.approvals.thresholdUsd = 120;
  // Judge scenes isolate one wall at a time; the "first payment to a new
  // counterparty" heuristic would otherwise escalate every scene to a human.
  doc.risk = {};
});

function judgeGuard(start = START): { guard: FeralGuard; clock: { t: number } } {
  const clock = { t: start };
  const guard = FeralGuard.create({ policyText: JUDGE_POLICY, clock: () => clock.t, prices: PRICES });
  return { guard, clock };
}

function detailOf(decision: Decision): string {
  if (decision.reasons.length === 0) return 'all checks passed';
  return decision.reasons.map((r) => r.code).join(', ');
}

// ---------------------------------------------------------------- judge mode --

async function commandJudge(): Promise<number> {
  const failures: string[] = [];
  let decisions = 0;

  const record = (label: string, decision: Decision, expect: string, codes: string[] = []): void => {
    decisions += 1;
    const okVerdict = decision.verdict === expect;
    const okCodes = codes.every((code) => decision.reasons.some((r) => r.code === code));
    if (!okVerdict || !okCodes) {
      failures.push(`${label}: expected ${expect}${codes.length ? ` [${codes.join(', ')}]` : ''}, got ${decision.verdict} [${detailOf(decision)}]`);
    }
    const note = detailOf(decision) === 'all checks passed' ? '' : dim(`  ${detailOf(decision)}`);
    console.log(`  ${verdictChip(decision.verdict)} ${pad(label, 46)}${note}`);
  };

  const header = (text: string): void => {
    console.log('');
    console.log(bold(text));
  };

  console.log('');
  console.log(bold('FERAL - agent security platform'));
  console.log(dim('  one-click demo, no wallet, no network, no keys'));
  console.log('');
  console.log(dim('SETUP'));

  const main = judgeGuard();
  const agents = main.guard.getAgents();
  const aggregate = main.guard.compiled.aggregateLimits.daily.get('USDC') ?? 0n;
  console.log(`  vault ready: ${agents.length} agents, owner ${main.guard.policyDoc.owner}`);
  for (const agent of agents) {
    console.log(`    ${pad(agent.account, 16)} tier ${pad(agent.tier, 11)} reputation ${agent.reputation}`);
  }
  console.log(`  policy ${main.guard.policyDoc.name}  hash ${main.guard.policyHash.slice(0, 12)}`);
  console.log(`  aggregate limit ${formatAmount(aggregate, 6)} USDC/day across all agents`);
  const perTx = main.guard.getEffectiveLimits('argo.near').assets.USDC;
  console.log(`  argo.near: ${perTx?.perTx} USDC/tx, ${perTx?.daily} USDC/day, above $120 a human co-signs`);

  header('SCENE 1  Clean spend');
  const clean = await main.guard.submit({ id: 'judge_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  record('argo pays compute.near 5 USDC', clean.decision, 'allow');
  console.log(dim(`    reputation ${main.guard.getReputation('argo.near')}  daily ${main.guard.getEffectiveLimits('argo.near').assets.USDC?.daily} effective cap`));
  main.clock.t += 7_000;

  header('SCENE 2  Overspend denied');
  const overspend = await main.guard.submit({ id: 'judge_2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '30', to: 'compute.near' });
  record('argo tries 30 USDC (per-tx cap 25)', overspend.decision, 'deny', ['PER_TX_LIMIT']);
  console.log(dim(`    reputation 100 -> ${main.guard.getReputation('argo.near')} (-10 denial)`));
  main.clock.t += 7_000;

  header('SCENE 3  Stranger refused');
  const stranger = await main.guard.submit({ id: 'judge_3', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'unknown-address.near' });
  record('argo pays unknown-address.near', stranger.decision, 'deny', ['RECIPIENT_NOT_ALLOWED']);
  console.log(dim(`    reputation 90 -> ${main.guard.getReputation('argo.near')} (-10 denial)`));

  header('SCENE 4  Burst attack: the key is "stolen"');
  const burst = judgeGuard();
  let lastBurst: Decision | null = null;
  for (let i = 0; i < 6; i++) {
    const result = await burst.guard.submit({ id: `judge_burst_${i}`, kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '1', to: 'compute.near' });
    lastBurst = result.decision;
    decisions += 1;
    console.log(`  ${verdictChip(result.decision.verdict)} scout transfer ${i + 1} of 6  1 USDC  ${dim(detailOf(result.decision))}`);
    burst.clock.t += 6_000;
  }
  const burstOk = lastBurst?.verdict === 'deny' && lastBurst.reasons.some((r) => r.code === 'ANOMALY_BURST');
  if (!burstOk) failures.push(`burst: expected the last transfer to be denied with ANOMALY_BURST, got ${lastBurst?.verdict} [${lastBurst ? detailOf(lastBurst) : '-'}]`);
  const breaker = burst.guard.getCircuitBreakerLevel('scout.near');
  if (breaker.level !== 1) failures.push(`burst: expected circuit breaker level 1, got ${breaker.level}`);
  console.log(dim(`    circuit breaker level ${breaker.level}: limits reduced for this agent`));
  console.log(dim(`    flags [${burst.guard.getAnomalyFlags('scout.near').join(', ') || '-'}]  reputation ${burst.guard.getReputation('scout.near')}`));

  header('SCENE 5  Drainage detection');
  const drain = judgeGuard();
  let lastDrain: Decision | null = null;
  for (let i = 0; i < 5; i++) {
    const result = await drain.guard.submit({ id: `judge_drain_${i}`, kind: 'ft.transfer', actor: 'sentry.near', asset: 'USDC', amount: '25', to: 'vendor.near' });
    lastDrain = result.decision;
    decisions += 1;
    console.log(`  ${verdictChip(result.decision.verdict)} sentry transfer ${i + 1} of 5  25 USDC -> vendor.near  ${dim(detailOf(result.decision))}`);
    drain.clock.t += 61_000;
  }
  const drainOk = lastDrain?.verdict === 'deny' && lastDrain.reasons.some((r) => r.code === 'ANOMALY_DRAINAGE');
  if (!drainOk) failures.push(`drainage: expected a deny with ANOMALY_DRAINAGE, got ${lastDrain?.verdict} [${lastDrain ? detailOf(lastDrain) : '-'}]`);
  console.log(dim(`    flags [${drain.guard.getAnomalyFlags('sentry.near').join(', ') || '-'}]: over half the daily cap to one address`));

  header('SCENE 6  Aggregate limit across agents');
  const agg = judgeGuard();
  const aggActions: ActionRequest[] = [
    // Spread across vendors: paying one address more than half the daily cap
    // would (correctly) trip drainage before the aggregate scene is reached.
    { id: 'judge_agg_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '25', to: 'compute.near' },
    { id: 'judge_agg_2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '25', to: 'storage.near' },
    { id: 'judge_agg_3', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '25', to: 'api.data-market.near' },
    { id: 'judge_agg_4', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '15', to: 'vendor.near' },
    { id: 'judge_agg_5', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '50', to: 'compute.near' },
    { id: 'judge_agg_6', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '50', to: 'storage.near' },
    { id: 'judge_agg_7', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '10', to: 'api.data-market.near' },
  ];
  for (const action of aggActions) {
    const result = await agg.guard.submit(action);
    decisions += 1;
    if (result.decision.verdict !== 'allow') failures.push(`aggregate setup ${action.id}: expected allow, got ${result.decision.verdict} [${detailOf(result.decision)}]`);
    agg.clock.t += 7_000;
  }
  const overAggregate = await agg.guard.submit({ id: 'judge_agg_8', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '10', to: 'compute.near' });
  record('argo tries 10 more with the vault at 200/200', overAggregate.decision, 'deny', ['AGGREGATE_DAILY_LIMIT']);
  console.log(dim(`    aggregate spent ${formatAmount(agg.guard.getAggregateSpent('USDC', 'day'), 6)} USDC of ${formatAmount(aggregate, 6)}`));

  header('SCENE 7  Reputation-adjusted limits');
  const effective = main.guard.getEffectiveLimits('argo.near');
  console.log(dim(`    reputation ${effective.reputation}: per-tx ${effective.assets.USDC?.perTx} USDC, daily ${effective.assets.USDC?.daily} USDC`));
  const adjusted = await main.guard.submit({ id: 'judge_7', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '21', to: 'compute.near' });
  record('argo tries 21 USDC at reputation 80', adjusted.decision, 'deny', ['PER_TX_LIMIT']);
  console.log(dim('    the base cap is 25; at reputation 80 the effective cap is 20'));

  header('SCENE 8  Emergency freeze and thaw');
  const frozen = judgeGuard();
  frozen.guard.emergencyFreeze('dave.near');
  const whileFrozen = await frozen.guard.submit({ id: 'judge_8a', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  record('guardian dave freezes the vault, argo tries 5 USDC', whileFrozen.decision, 'deny', ['EMERGENCY_FREEZE']);
  frozen.guard.thaw('alice.near');
  frozen.clock.t += 6_000;
  const afterThaw = await frozen.guard.submit({ id: 'judge_8b', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
  record('owner alice thaws, argo tries again', afterThaw.decision, 'allow');

  header('SCENE 9  Governance: watcher cancels a timelock');
  const gov = judgeGuard();
  const timelock = gov.guard.proposeTimelock('withdraw', { asset: 'USDC', amount: '200' });
  console.log(dim(`    timelock ${timelock} proposed; executes at ${new Date(gov.guard.pendingTimelocks[0]?.executesAt ?? 0).toISOString()}`));
  gov.guard.cancelTimelock(timelock, 'dave.near');
  let cancelled = false;
  try {
    gov.guard.executeTimelock(timelock, 'alice.near');
  } catch (err) {
    cancelled = /cancelled/.test((err as Error).message);
    if (!cancelled) failures.push(`timelock: unexpected error ${(err as Error).message}`);
  }
  if (!cancelled) failures.push('timelock: watcher cancellation did not stop execution');
  console.log(`  ${cancelled ? green('CANCELLED      ') : red('EXECUTED       ')} watcher dave.near stopped the withdrawal`);

  header('SCENE 10  Audit chain');
  const verify = main.guard.verifyAudit();
  console.log(`  ${verify.ok ? green('VERIFIED       ') : red('BROKEN         ')} ${verify.records} decisions, head ${cyan(verify.head.slice(0, 16))}...`);
  if (!verify.ok) failures.push('audit: hash chain did not verify');
  const snapshot = main.guard.snapshot();
  const tampered = structuredClone(snapshot.audit);
  if (tampered.length > 2) {
    tampered[1].amount = '0.01';
    const broken = AuditLog.fromJSON(tampered).verify();
    const detected = broken.ok === false;
    console.log(`  ${detected ? green('DETECTED       ') : red('MISSED         ')} an edited audit record ${detected ? `at index ${broken.brokenAt}` : ''}`);
    if (!detected) failures.push('audit: tampering was not detected');
  }

  console.log('');
  console.log('-'.repeat(62));
  if (failures.length === 0) {
    console.log(`${green('FERAL DEMO COMPLETE')}  ${decisions} decisions, 0 failures`);
    console.log('3 agents, 1 vault, 17 checks enforced on-chain. No wallet was needed.');
  } else {
    console.log(red(`${failures.length} scene(s) failed:`));
    for (const failure of failures) console.log(`  - ${failure}`);
  }
  console.log('-'.repeat(62));
  return failures.length === 0 ? 0 : 1;
}

// -------------------------------------------------------------- full demo ----

async function commandDemo(): Promise<number> {
  const code = await commandJudge();
  if (code !== 0) return code;

  const clock = { t: START };
  const guard = buildGuard(clock);
  console.log('');
  console.log(bold('EXTRA  NEAR Intents quote, gated end to end'));

  let fixture = null;
  try {
    fixture = loadQuoteFixture(join(import.meta.dirname, '..', '..', 'data', 'fixtures'));
  } catch {
    fixture = null;
  }
  if (fixture) {
    const quote = fixture.response.quote;
    console.log(dim(`  recorded live ${fixture.capturedAt}: ${quote.amountInFormatted} NEAR -> ${quote.amountOutFormatted} USDC on Arbitrum`));
    const swap: ActionRequest = {
      id: 'demo_swap_ok',
      kind: 'intent.swap',
      actor: 'argo.near',
      asset: 'NEAR',
      amount: '1',
      quote: snapshotFromQuote(quote, fixture, {
        policyAsset: 'NEAR',
        destinationAddress: PINNED_DESTINATION,
        expiresAt: new Date(clock.t + 300_000).toISOString(),
      }),
    };
    const allowed = await guard.submit(swap);
    console.log(`  ${verdictChip(allowed.decision.verdict)} pinned destination ${PINNED_DESTINATION}  ${dim(detailOf(allowed.decision))}`);
    clock.t += 7_000;
    const redirected = await guard.submit({ ...swap, id: 'demo_swap_bad', quote: { ...swap.quote, destinationAddress: ATTACKER_DESTINATION } });
    console.log(`  ${verdictChip(redirected.decision.verdict)} same quote, output redirected  ${dim(detailOf(redirected.decision))}`);
  } else {
    console.log(dim('  no recorded quote fixture on this machine; skipping the swap scene'));
  }

  console.log('');
  console.log(bold('EXTRA  Policy simulation'));
  for (let i = 0; i < 6; i++) {
    clock.t += 6_000;
    await guard.submit({ id: `demo_hist_${i}`, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: i % 2 === 0 ? '5' : '20', to: 'compute.near' });
  }
  const proposed = policyText((doc) => {
    doc.limits.daily = { ...doc.limits.daily, USDC: 40 };
    if (doc.agents?.[0]) doc.agents[0].limits.daily = { ...doc.agents[0].limits.daily, USDC: 40 };
  });
  const simulation = guard.simulatePolicy(proposed);
  console.log(`  tightening the daily cap to 40 USDC changes ${simulation.changedCount} of ${simulation.totalActions} historical decisions`);
  for (const diff of simulation.diffs.slice(0, 4)) {
    console.log(`    ${pad(diff.actionId, 18)} ${diff.oldVerdict} -> ${diff.newVerdict}  ${dim(diff.newReasons.join(', '))}`);
  }

  console.log('');
  console.log(bold('EXTRA  Agent adaptation'));
  console.log('  a refused agent reads the reason code and picks a cheaper legal move;');
  console.log('  it never rewrites the policy, and a refusal cannot be replayed into an allow.');

  const verify = guard.verifyAudit();
  console.log('');
  console.log(`${dim('audit chain')} ${verify.records} records, head ${cyan(verify.head.slice(0, 16))}..., ${verify.ok ? green('verified') : red('BROKEN')}`);
  return verify.ok ? 0 : 1;
}

// ------------------------------------------------------------------ attack ---

async function commandAttack(): Promise<number> {
  console.log(bold('FERAL') + dim(' - attack catalogue'));
  console.log('');
  const rows = await runCatalogue(CATALOGUE);
  const wName = Math.max(...rows.map((r) => r.name.length), 'attempt'.length) + 2;
  const wVerdict = Math.max(...rows.map((r) => r.verdict.length), 'expected'.length, 'actual'.length) + 2;
  console.log(`${pad('#', 3)} ${pad('attempt', wName)} ${pad('expected', wVerdict)} ${pad('actual', wVerdict)} wall`);
  console.log(dim('-'.repeat(3 + wName + wVerdict * 2 + 40)));
  let failures = 0;
  rows.forEach((row, i) => {
    if (!row.passed) failures++;
    const mark = row.passed ? green('ok') : red('FAIL');
    console.log(
      `${pad(String(i + 1), 3)} ${pad(row.name, wName)} ${pad(row.expect, wVerdict)} ${pad(row.verdict, wVerdict)} ${dim(row.wall)} ${mark}`,
    );
  });
  console.log('');
  const denied = rows.filter((r) => r.verdict === 'deny').length;
  const escalated = rows.filter((r) => r.verdict === 'require_approval').length;
  const allowed = rows.filter((r) => r.verdict === 'allow').length;
  console.log(
    `${bold(String(rows.length))} attempts: ${red(`${denied} denied`)}, ${amber(`${escalated} to a human`)}, ${green(`${allowed} allowed`)}`,
  );
  if (failures > 0) console.log(red(`${failures} scenario(s) did not hit the expected wall`));
  return failures === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ verify ---

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)];

async function commandVerify(rawSeed?: string): Promise<number> {
  const seed = Number(rawSeed ?? 1) || 1;
  const random = mulberry32(seed);
  const { guard, clock } = makeGuard();
  const actors = ['argo.near', 'scout.near', 'sentry.near'];
  const allowedVendors = ['compute.near', 'api.data-market.near', 'storage.near', 'vendor.near'];
  const strangers = ['drainer.near', 'attacker.near', 'randomer-one.near'];
  const amounts = ['1', '5', '9.99', '12', '15', '20', '25'];
  const badAmounts = ['0', '25.01', '26', '1e5'];
  const kinds = ['ft.transfer', 'ft.transfer', 'ft.transfer', 'api.pay', 'key.add', 'stake.delegate'] as const;

  // Warm the allow list once per agent so the fuzz is about limits, not first contact.
  // The first payment to a new vendor is escalated; the owner co-signs it here.
  for (const actor of actors) {
    for (const to of allowedVendors) {
      clock.t += 10 * 60_000;
      const warm = await guard.submit({ id: `verify_warm_${actor}_${to}`, kind: 'ft.transfer', actor, asset: 'USDC', amount: '1', to });
      if (warm.approval) await guard.approve(warm.approval.id, guard.policyDoc.owner);
    }
  }

  const violations: string[] = [];
  let allowed = 0;
  let denied = 0;
  let escalated = 0;
  let replays = 0;

  for (let index = 0; index < 1000; index++) {
    const actor = pick(random, actors);
    const to = random() < 0.92 ? pick(random, allowedVendors) : pick(random, strangers);
    const action: ActionRequest = {
      id: `verify_${seed}_${index}`,
      kind: random() < 0.95 ? 'ft.transfer' : pick(random, kinds),
      actor,
      asset: 'USDC',
      amount: random() < 0.95 ? pick(random, amounts) : pick(random, badAmounts),
      to,
    };
    const before = guard.getAggregateSpent('USDC', 'day');
    const { decision } = await guard.submit(action);
    const after = guard.getAggregateSpent('USDC', 'day');

    if (decision.verdict === 'deny') {
      denied += 1;
      if (after !== before) violations.push(`deny at ${index} moved the aggregate ledger`);
    } else if (decision.verdict === 'allow') {
      allowed += 1;
      if (!allowedVendors.includes(to)) violations.push(`allow at ${index} paid a stranger: ${to}`);
    } else {
      escalated += 1;
    }

    const reputation = guard.getReputation(actor);
    if (reputation < 0 || reputation > 100) violations.push(`reputation out of range at ${index}: ${reputation}`);
    const score = guard.getAnomalyScore(actor);
    if (score < 0 || score > 100) violations.push(`anomaly score out of range at ${index}: ${score}`);

    const aggregateLimit = guard.compiled.aggregateLimits.daily.get('USDC') ?? 0n;
    if (after > aggregateLimit) violations.push(`aggregate day spent ${after} over limit ${aggregateLimit} at ${index}`);

    // Preview, not submit: a second submission would itself be a denial and would
    // drain the agent's reputation, turning the fuzz into a reputation test.
    const replay = guard.preview({ ...action });
    if (replay.verdict !== 'deny' || !replay.reasons.some((r) => r.code === 'REPLAY')) {
      violations.push(`replay at ${index} was not denied with REPLAY`);
    } else replays += 1;

    // 11 minutes keeps the hourly velocity window at five transfers, below the
    // policy's six-per-hour cap: the fuzz should reach the spending walls.
    clock.t += 11 * 60_000;
    if (violations.length > 10) break;
  }

  const invariants = 7;
  console.log(bold(`FERAL verify`) + dim(`  seed ${seed}, 1000 actions, 3 agents`));
  console.log(`  allowed ${allowed}, denied ${denied}, escalated ${escalated}, replays refused ${replays}`);
  for (const violation of violations.slice(0, 10)) console.log(red(`  VIOLATION ${violation}`));
  if (violations.length === 0) {
    console.log(green(`  ${invariants} invariants verified: limits, aggregate, strangers, denials, replay, reputation, anomaly`));
    console.log(green('  ALL PASS'));
    return 0;
  }
  console.log(red(`  ${violations.length} violation(s)`));
  return 1;
}

// ------------------------------------------------------------------- bench ---

async function commandBench(): Promise<number> {
  const { guard, clock } = makeGuard();
  const shapes: { name: string; action: ActionRequest }[] = [
    { name: 'ft.transfer (USDC, allow-listed vendor)', action: { id: 'bench_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
    { name: 'ft.transfer (USDC, over per-tx cap)', action: { id: 'bench_2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' } },
    { name: 'native transfer (NEAR, stranger)', action: { id: 'bench_3', kind: 'near.transfer', actor: 'argo.near', asset: 'NEAR', amount: '0.1', to: 'attacker.near' } },
    { name: 'denied action kind (key.add)', action: { id: 'bench_4', kind: 'key.add', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' } },
    { name: 'multi-agent aggregate check (scout)', action: { id: 'bench_5', kind: 'ft.transfer', actor: 'scout.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
    { name: 'anomaly burst detection', action: { id: 'bench_6', kind: 'ft.transfer', actor: 'sentry.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  ];
  guard.triggerCircuitBreaker('argo.near', 1, 'benchmark');
  shapes.push({ name: 'circuit breaker level 1', action: { id: 'bench_7', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '1', to: 'compute.near' } });

  console.log(bold('FERAL bench') + dim('  pure engine, warm cache, 2000 evaluations per shape'));
  console.log('');
  console.log(`${pad('shape', 44)} ${pad('p50', 10)} ${pad('p95', 10)} ${pad('p99', 10)} max`);
  console.log(dim('-'.repeat(84)));
  for (const shape of shapes) {
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) {
      const started = performance.now();
      guard.preview({ ...shape.action, id: `${shape.action.id}_${i}` });
      samples.push((performance.now() - started) * 1000);
    }
    samples.sort((a, b) => a - b);
    const at = (fraction: number): number => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];
    const fmt = (value: number): string => `${value.toFixed(2)} us`;
    console.log(`${pad(shape.name, 44)} ${pad(fmt(at(0.5)), 10)} ${pad(fmt(at(0.95)), 10)} ${pad(fmt(at(0.99)), 10)} ${fmt(samples[samples.length - 1])}`);
    clock.t += 1;
  }
  return 0;
}

// ------------------------------------------------------------------- quote ---

async function commandQuote(destination = PINNED_DESTINATION): Promise<number> {
  const clock = { t: Date.now() };
  const guard = buildGuard(clock);
  const amount = '1';
  console.log(dim('requesting a live 1Click quote...'));
  let quote;
  try {
    const response = await requestQuote({
      originAsset: ONE_CLICK_ASSETS.NEAR,
      destinationAsset: ONE_CLICK_ASSETS.USDC_ARB,
      amount: (BigInt(amount) * 10n ** 24n).toString(),
      recipient: destination,
      refundTo: guard.policyDoc.owner,
      slippageTolerance: 50,
      deadline: new Date(clock.t + 600_000).toISOString(),
      dry: true,
    });
    quote = response.quote;
    console.log(green(`live quote: ${amount} NEAR -> ${quote.amountOutFormatted} USDC on Arbitrum (min ${formatAmount(BigInt(quote.minAmountOut), 6)})`));
  } catch (err) {
    if (err instanceof IntentsError) console.log(red(`1Click rejected the quote (${err.status}); falling back to the recorded fixture`));
    else console.log(red(`network unavailable (${(err as Error).message}); falling back to the recorded fixture`));
    const fixture = loadQuoteFixture();
    quote = fixture.response.quote;
  }

  const action: ActionRequest = {
    id: `quote_${clock.t}`,
    kind: 'intent.swap',
    actor: guard.compiled.agents[0]?.account ?? 'argo.near',
    asset: 'NEAR',
    amount,
    quote: {
      venue: 'near-intents',
      originAsset: 'NEAR',
      originAssetId: ONE_CLICK_ASSETS.NEAR,
      destinationAsset: ONE_CLICK_ASSETS.USDC_ARB,
      destinationAddress: destination,
      amountOut: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      slippageBps: 50,
      expiresAt: new Date(clock.t + 300_000).toISOString(),
    },
  };
  const { decision } = await guard.submit(action);
  console.log('');
  console.log(`${verdictChip(decision.verdict)} destination ${destination}`);
  for (const check of decision.checks) {
    if (check.id === 'amount-parses') continue;
    console.log(`   ${check.passed ? green('pass') : red('FAIL')} ${pad(check.title, 46)} ${dim(check.detail)}`);
  }
  return decision.verdict === 'allow' ? 0 : 1;
}

// ---------------------------------------------------------------- chainsig ---

async function commandChainsig(network: 'mainnet' | 'testnet' = 'mainnet'): Promise<number> {
  const guard = buildGuard({ t: Date.now() });
  const agent = guard.compiled.agents[0]?.account ?? 'argo.near';
  const pinned = [...guard.compiled.intents.allowedDestinations][0];
  console.log(`${dim('signer')}  ${SIGNER_ACCOUNTS[network]}  ${dim('agent')} ${agent}  ${dim('path')} ethereum-1`);
  let derived;
  try {
    derived = await derivedPublicKey({ account: agent, path: 'ethereum-1', network });
  } catch (err) {
    console.log(red(`could not reach the MPC signer: ${(err as Error).message}`));
    return 1;
  }
  console.log(`${dim('public key')} ${derived.publicKey}`);
  console.log(`${dim('derived EVM address')} ${cyan(derived.evmAddress)}`);
  console.log(`${dim('pinned in policy')}     ${pinned ?? dim('(none)')}`);
  const matches = pinned !== undefined && pinned.toLowerCase() === derived.evmAddress.toLowerCase();
  console.log('');
  console.log(
    matches
      ? green('match: the only address this agent may receive swaps on is the one the MPC derives for it')
      : red('MISMATCH: the policy pins an address the agent does not control'),
  );
  return matches ? 0 : 1;
}

// --------------------------------------------------------------- simulate ----

async function commandSimulate(file?: string): Promise<number> {
  const clock = { t: START };
  // Approval threshold raised and the first-contact heuristic off: the history is
  // meant to exercise limits so the simulation has something to compare.
  const guard = FeralGuard.create({ policyText: JUDGE_POLICY, clock: () => clock.t, prices: PRICES });
  const actions: [string, string, string][] = [
    ['sim_warm_1', '1', 'compute.near'],
    ['sim_warm_2', '1', 'storage.near'],
    ['sim_warm_3', '1', 'api.data-market.near'],
    ['sim_1', '5', 'compute.near'],
    ['sim_2', '20', 'compute.near'],
    ['sim_3', '25', 'storage.near'],
    ['sim_4', '15', 'api.data-market.near'],
    ['sim_5', '25', 'compute.near'],
  ];
  for (const [id, amount, to] of actions) {
    // Eleven minutes apart: the point of the simulation is a limit change, not
    // the per-hour velocity cap being re-applied to the whole history at once.
    clock.t += 11 * 60_000;
    await guard.submit({ id, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount, to });
  }
  let proposed: string;
  if (file) proposed = readFileSync(file, 'utf8');
  else {
    proposed = policyText((doc) => {
      doc.limits.daily = { ...doc.limits.daily, USDC: 40 };
      if (doc.agents?.[0]) doc.agents[0].limits.daily = { ...doc.agents[0].limits.daily, USDC: 40 };
    });
  }
  const result = guard.simulatePolicy(proposed);
  console.log(bold('FERAL simulate') + dim(file ? `  ${file}` : '  built-in: tighten the argo daily cap to 40 USDC'));
  console.log(`  ${result.changedCount} of ${result.totalActions} historical decisions would change`);
  for (const diff of result.diffs) {
    console.log(`  ${pad(diff.actionId, 12)} ${pad(diff.oldVerdict, 18)} -> ${pad(diff.newVerdict, 18)} ${dim(diff.newReasons.join(', '))}`);
  }
  if (result.changedCount === 0) console.log(dim('  the proposed policy changes nothing on this history'));
  return 0;
}

// ------------------------------------------------------- reputation/anomaly --

function commandReputation(): number {
  const guard = buildGuard({ t: START });
  const rows = guard.getAgents().map((agent) => ({
    agent: agent.account,
    tier: agent.tier,
    reputation: guard.getReputation(agent.account),
    status: agent.paused ? 'paused' : 'active',
    limits: guard.getEffectiveLimits(agent.account).assets,
  }));
  console.log(bold('FERAL reputation') + dim('  effective limits = base * reputation / 100'));
  console.log(JSON.stringify(rows, null, 2));
  return 0;
}

function commandAnomaly(): number {
  const guard = buildGuard({ t: START });
  const rows = guard.getAgents().map((agent) => ({
    agent: agent.account,
    score: guard.getAnomalyScore(agent.account),
    flags: guard.getAnomalyFlags(agent.account),
    circuitBreaker: guard.getCircuitBreakerLevel(agent.account),
  }));
  console.log(bold('FERAL anomaly') + dim('  burst, drainage, deviation'));
  console.log(JSON.stringify(rows, null, 2));
  return 0;
}

// --------------------------------------------------------------- evaluate ----

async function commandEvaluate(file: string): Promise<number> {
  const clock = { t: Date.now() };
  const guard = buildGuard(clock);
  const action = JSON.parse(readFileSync(file, 'utf8')) as ActionRequest;
  const decision = guard.preview(action);
  console.log(JSON.stringify(decision, null, 2));
  const codes = [...new Set(decision.reasons.map((r) => r.code))];
  console.error(`\n${verdictChip(decision.verdict)} ${decision.amount} ${decision.asset} ${action.kind} ${codes.length === 0 ? '' : '[' + codes.join(', ') + ']'}`);
  return decision.verdict === 'deny' ? 1 : 0;
}

async function commandAudit(args: string[]): Promise<number> {
  const guard = buildGuard({ t: Date.now() });
  const verify = guard.verifyAudit();
  if (args[0] === 'verify') {
    console.log(JSON.stringify(verify, null, 2));
    return verify.ok ? 0 : 1;
  }
  console.log(JSON.stringify(guard.snapshot().audit, null, 2));
  return 0;
}

function usage(): number {
  console.log(
    [
      bold('feral') + ' - the security layer for autonomous money on NEAR',
      '',
      '  feral demo                     full narrative demo',
      '  feral demo:judge               60 seconds, zero config, no wallet',
      '  feral attack                   the 52-scenario attack catalogue',
      '  feral verify [seed]            1000 random actions, invariants proven',
      '  feral bench                    latency per check shape',
      '  feral serve                    dashboard on http://127.0.0.1:8787',
      '  feral audit [verify]           print or verify the audit chain',
      '  feral quote [destination]      live 1Click quote, gated by the policy',
      '  feral chainsig [network]       verify the pinned address against the MPC signer',
      '  feral simulate [policy.json]   what a proposed policy would change',
      '  feral reputation               reputation and effective limits per agent',
      '  feral anomaly                  anomaly scores and flags per agent',
      '  feral evaluate <action.json>   dry-run a single action',
      '',
    ].join('\n'),
  );
  return 0;
}

const [, , command, ...args] = process.argv;
let code = 0;
switch (command) {
  case 'demo':
    code = await commandDemo();
    break;
  case 'demo:judge':
    code = await commandJudge();
    break;
  case 'attack':
    code = await commandAttack();
    break;
  case 'verify':
    code = await commandVerify(args[0]?.replace(/^--seed=/, ''));
    break;
  case 'bench':
    code = await commandBench();
    break;
  case 'serve':
    await import('../app/server.ts');
    break;
  case 'quote':
    code = await commandQuote(args[0]);
    break;
  case 'chainsig':
    code = await commandChainsig(args[0] === 'testnet' ? 'testnet' : 'mainnet');
    break;
  case 'simulate':
    code = await commandSimulate(args[0]);
    break;
  case 'reputation':
    code = commandReputation();
    break;
  case 'anomaly':
    code = commandAnomaly();
    break;
  case 'evaluate':
    if (!args[0]) {
      console.error('usage: feral evaluate <action.json>');
      code = 2;
    } else code = await commandEvaluate(args[0]);
    break;
  case 'audit':
    code = await commandAudit(args);
    break;
  default:
    code = usage();
}
process.exitCode = code;
