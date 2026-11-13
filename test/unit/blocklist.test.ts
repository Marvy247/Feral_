/**
 * Unit tests for the shared blocklist registry and counterparty wrapper.
 *
 * Run with:  npm run test  (picked up by the Node test runner glob)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Blocklist } from '../../src/core/blocklist.ts';
import { CounterpartyGuard } from '../../src/integrations/counterparty.ts';
import { FeralGuard } from '../../src/core/service.ts';
import { DEFAULT_PRICES } from '../../src/core/engine.ts';

const policyPath = join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
const policyText = readFileSync(policyPath, 'utf8');

function makeGuard() {
  return FeralGuard.create({ policyText, prices: DEFAULT_PRICES, clock: () => Date.now() });
}

// ── Blocklist unit tests ──────────────────────────────────────────────────────

describe('Blocklist', () => {
  it('returns allow for an unknown address', () => {
    const bl = new Blocklist();
    const result = bl.query('stranger.near');
    assert.equal(result.rating, 'allow');
    assert.equal(result.reportCount, 0);
    assert.equal(result.uniqueReporters, 0);
  });

  it('returns warn after one unique reporter', () => {
    const bl = new Blocklist();
    bl.report('bad.near', 'vault-a', 'attempted drain', 'evidence-123');
    const result = bl.query('bad.near');
    assert.equal(result.rating, 'warn');
    assert.equal(result.uniqueReporters, 1);
    assert.equal(result.reportCount, 1);
  });

  it('returns block after two unique reporters', () => {
    const bl = new Blocklist();
    bl.report('bad.near', 'vault-a', 'attempted drain', 'evidence-a');
    bl.report('bad.near', 'vault-b', 'same address hit us too', 'evidence-b');
    const result = bl.query('bad.near');
    assert.equal(result.rating, 'block');
    assert.equal(result.uniqueReporters, 2);
  });

  it('stays at warn when the same reporter files multiple reports', () => {
    const bl = new Blocklist();
    bl.report('bad.near', 'vault-a', 'first report', 'ev1');
    bl.report('bad.near', 'vault-a', 'second report', 'ev2');
    bl.report('bad.near', 'vault-a', 'third report', 'ev3');
    const result = bl.query('bad.near');
    // 3 reports but only 1 unique reporter → warn, not block
    assert.equal(result.rating, 'warn');
    assert.equal(result.uniqueReporters, 1);
    assert.equal(result.reportCount, 3);
  });

  it('seeded addresses are always block regardless of report count', () => {
    const bl = new Blocklist();
    bl.seed('known-drainer.near', 'known bad actor from previous on-chain incident');
    const result = bl.query('known-drainer.near');
    assert.equal(result.rating, 'block');
    assert.ok(result.reasons.some((r) => r.includes('known-bad seed')));
  });

  it('stores evidence hashes, not raw evidence', () => {
    const bl = new Blocklist();
    const rpt = bl.report('bad.near', 'vault-a', 'drain attempt', 'raw-audit-hash-abc123');
    // evidence is stored as sha256(raw), not the raw string itself
    assert.ok(rpt.evidenceHash.length === 64, 'evidence hash should be 64-char hex');
    assert.notEqual(rpt.evidenceHash, 'raw-audit-hash-abc123');
    const result = bl.query('bad.near');
    assert.ok(result.evidenceHashes.includes(rpt.evidenceHash));
  });

  it('reports older than TTL are not counted for single-reporter addresses', () => {
    const now = Date.now();
    // Start 31 days in the past.
    let t = now - 31 * 24 * 60 * 60 * 1000;
    const bl = new Blocklist(() => t);

    bl.report('old-report.near', 'vault-a', 'old drain', 'ev-old');

    // Advance clock to now — the old report should have expired.
    t = now;
    const result = bl.query('old-report.near');
    assert.equal(result.rating, 'allow', 'single old report should expire to allow');
  });

  it('flagged() returns only non-allow entries', () => {
    const bl = new Blocklist();
    bl.report('bad.near', 'vault-a', 'drain', 'ev');
    bl.report('also-bad.near', 'vault-a', 'another', 'ev2');
    bl.report('also-bad.near', 'vault-b', 'confirmed', 'ev3');
    const flagged = bl.flagged();
    assert.equal(flagged.length, 2);
    const ratings = flagged.map((f) => f.rating);
    assert.ok(ratings.includes('warn'));
    assert.ok(ratings.includes('block'));
  });

  it('snapshot and restore round-trips correctly', () => {
    const bl = new Blocklist();
    bl.report('bad.near', 'vault-a', 'test', 'ev');
    bl.seed('known.near');
    const snap = bl.snapshot();

    const bl2 = new Blocklist();
    bl2.restore(snap);
    assert.equal(bl2.query('bad.near').rating, 'warn');
    assert.equal(bl2.query('known.near').rating, 'block');
  });
});

// ── CounterpartyGuard unit tests ─────────────────────────────────────────────

describe('CounterpartyGuard', () => {
  it('passes through allow-listed addresses unchanged', async () => {
    const bl = new Blocklist();
    const guard = makeGuard();
    const cg = new CounterpartyGuard(guard, bl);
    const agent = guard.compiled.agents[0]?.account ?? 'argo.near';

    const result = await cg.submit({
      id: 'cg_allow_test',
      kind: 'near.transfer',
      actor: agent,
      asset: 'NEAR',
      amount: '0.1',
      to: 'vendor.near',
    });

    assert.equal(result.check.rating, 'allow');
    assert.equal(result.submitted, true);
    assert.ok(result.decision !== undefined);
  });

  it('refuses to submit when address is blocked', async () => {
    const bl = new Blocklist();
    const guard = makeGuard();
    const cg = new CounterpartyGuard(guard, bl);
    const agent = guard.compiled.agents[0]?.account ?? 'argo.near';

    // Two reporters to trigger block.
    bl.report('attacker.near', 'vault-x', 'known drain', 'ev-x');
    bl.report('attacker.near', 'vault-y', 'confirmed', 'ev-y');

    const result = await cg.submit({
      id: 'cg_block_test',
      kind: 'near.transfer',
      actor: agent,
      asset: 'NEAR',
      amount: '1.0',
      to: 'attacker.near',
    });

    assert.equal(result.check.rating, 'block');
    assert.equal(result.submitted, false);
    assert.ok(result.refusal !== undefined && result.refusal.includes('attacker.near'));
    // Guard was never called — no decision returned.
    assert.equal(result.decision, undefined);
  });

  it('submits with annotation when address is warned', async () => {
    const bl = new Blocklist();
    const guard = makeGuard();
    const cg = new CounterpartyGuard(guard, bl);
    const agent = guard.compiled.agents[0]?.account ?? 'argo.near';

    // One reporter — warn.
    bl.report('suspicious.near', 'vault-x', 'one report only', 'ev-x');

    const result = await cg.submit({
      id: 'cg_warn_test',
      kind: 'near.transfer',
      actor: agent,
      asset: 'NEAR',
      amount: '0.1',
      to: 'suspicious.near',
    });

    assert.equal(result.check.rating, 'warn');
    // Was submitted (guard was called), even if the guard may deny for other reasons.
    assert.equal(result.submitted, true);
  });

  it('report() updates the registry and returns the new rating', () => {
    const bl = new Blocklist();
    const guard = makeGuard();
    const cg = new CounterpartyGuard(guard, bl);

    cg.report('bad.near', 'vault-a', 'drain attempt', 'ev-a');
    cg.report('bad.near', 'vault-b', 'confirmed', 'ev-b');

    const result = cg.check('bad.near');
    assert.equal(result.rating, 'block');
    assert.equal(result.reasons.length, 2);
  });

  it('cross-vault: vault-B blocked by vault-A report', async () => {
    const bl = new Blocklist();
    const guardA = makeGuard();
    const guardB = makeGuard();
    const cgA = new CounterpartyGuard(guardA, bl);
    const cgB = new CounterpartyGuard(guardB, bl);

    const agentA = guardA.compiled.agents[0]?.account ?? 'argo.near';
    const agentB = guardB.compiled.agents[0]?.account ?? 'argo.near';

    // vault-A encounters bad address and reports it.
    cgA.report('crossvault-bad.near', agentA, 'drain from vault-A', 'ev-a');
    // A second independent vault also reports.
    cgA.report('crossvault-bad.near', 'independent-watcher', 'confirmed bad', 'ev-ind');

    // vault-B has never seen this address, but the shared registry blocks it.
    const result = await cgB.submit({
      id: 'cross_vault_block_test',
      kind: 'near.transfer',
      actor: agentB,
      asset: 'NEAR',
      amount: '1.0',
      to: 'crossvault-bad.near',
    });

    assert.equal(result.check.rating, 'block');
    assert.equal(result.submitted, false,
      'vault-B should be blocked by vault-A\'s report via the shared registry');
  });
});
