/**
 * Cross-vault shared blocklist: counterparty reputation registry.
 *
 * Any agent in any vault can report a bad address here, attaching an evidence
 * hash so the claim is auditable. Any vault can query it before submitting a
 * spend. The registry is in-process and shared by reference, so all guards in
 * the same process share one view — the cross-vault property that the per-vault
 * denylist cannot provide.
 *
 * In production this would be a separate NEAR contract (a view call before
 * spend, a report call after a detected attack). The in-process design keeps the
 * hackathon demo dependency-free and verifiable offline.
 *
 * Scoring model:
 *   - 1 unique reporter with evidence  → warn  (1 report could be a mistake)
 *   - 2+ unique reporters              → block (independent corroboration)
 *   - 3+ reports from the same agent   → still warn (not independent)
 *   - known-bad seed list              → block immediately
 *
 * The rating degrades over time: a single report older than TTL_MS reverts to
 * allow so the registry self-cleans. Multiple independent reports do not expire
 * until all of them are old.
 */

import { sha256Hex } from './canonical.ts';

export type BlocklistRating = 'allow' | 'warn' | 'block';

export interface BlocklistReport {
  /** The address being reported. */
  address: string;
  /** Which agent (or vault) is filing the report. */
  reporter: string;
  /** Free-text reason, stored only — never parsed for control flow. */
  reason: string;
  /**
   * sha256 of any evidence the reporter wants to attach (tx hash, log line,
   * audit record hash, etc.). The registry stores the hash, not the raw data,
   * so evidence cannot be forged after the fact.
   */
  evidenceHash: string;
  /** Unix ms. */
  reportedAt: number;
}

export interface BlocklistEntry {
  address: string;
  reports: BlocklistReport[];
  /** Set to true for addresses that are seeded as unconditionally bad. */
  seeded: boolean;
  /** Cached rating, recomputed on every mutation. */
  rating: BlocklistRating;
  /** All unique reporters. */
  reporters: string[];
  /** Most recent report time. */
  lastReportedAt: number;
}

export interface BlocklistQueryResult {
  address: string;
  rating: BlocklistRating;
  reportCount: number;
  uniqueReporters: number;
  reasons: string[];
  /** Evidence hashes the caller can use to verify the claims independently. */
  evidenceHashes: string[];
  lastReportedAt: number | null;
}

/** Reports older than this are not counted when only one reporter exists. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Minimum unique reporters to escalate from warn → block. */
const BLOCK_THRESHOLD = 2;

function computeRating(entry: Pick<BlocklistEntry, 'reports' | 'seeded'>, now: number): BlocklistRating {
  if (entry.seeded) return 'block';

  const active = entry.reports.filter((r) => now - r.reportedAt < TTL_MS);
  if (active.length === 0) return 'allow';

  const uniqueReporters = new Set(active.map((r) => r.reporter));
  if (uniqueReporters.size >= BLOCK_THRESHOLD) return 'block';

  return 'warn';
}

/**
 * The shared blocklist registry.
 *
 * A single instance is exported as `sharedBlocklist` so all guards in the
 * process share one view. Tests can construct their own instance for isolation.
 */
export class Blocklist {
  private entries = new Map<string, BlocklistEntry>();
  private clock: () => number;

  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  /**
   * Seed an address as unconditionally blocked (e.g. known drainer contracts,
   * addresses from prior on-chain attack incidents).
   */
  seed(address: string, reason = 'known-bad seed'): void {
    const existing = this.entries.get(address);
    if (existing) {
      existing.seeded = true;
      existing.rating = 'block';
      return;
    }
    this.entries.set(address, {
      address,
      reports: [],
      seeded: true,
      rating: 'block',
      reporters: [],
      lastReportedAt: 0,
    });
  }

  /**
   * File a report against an address.
   *
   * @param address   - The counterparty being reported.
   * @param reporter  - The agent or vault filing the report.
   * @param reason    - Human-readable description; stored, never parsed.
   * @param evidence  - Raw evidence string; stored as sha256 so it cannot be
   *                    altered retroactively.
   */
  report(address: string, reporter: string, reason: string, evidence = ''): BlocklistReport {
    const evidenceHash = evidence ? sha256Hex(evidence) : sha256Hex(`${reporter}:${address}:${reason}`);
    const rpt: BlocklistReport = {
      address,
      reporter,
      reason,
      evidenceHash,
      reportedAt: this.clock(),
    };

    let entry = this.entries.get(address);
    if (!entry) {
      entry = {
        address,
        reports: [],
        seeded: false,
        rating: 'allow',
        reporters: [],
        lastReportedAt: 0,
      };
      this.entries.set(address, entry);
    }

    entry.reports.push(rpt);
    if (!entry.reporters.includes(reporter)) entry.reporters.push(reporter);
    entry.lastReportedAt = rpt.reportedAt;
    entry.rating = computeRating(entry, this.clock());

    return rpt;
  }

  /**
   * Query the current standing of an address.
   *
   * Always returns a result — unknown addresses get `allow` with zero reports.
   */
  query(address: string): BlocklistQueryResult {
    const entry = this.entries.get(address);
    const now = this.clock();

    if (!entry) {
      return {
        address,
        rating: 'allow',
        reportCount: 0,
        uniqueReporters: 0,
        reasons: [],
        evidenceHashes: [],
        lastReportedAt: null,
      };
    }

    // Recompute in case time has passed since last mutation.
    const rating = computeRating(entry, now);
    entry.rating = rating;

    const active = entry.reports.filter((r) => now - r.reportedAt < TTL_MS || entry.seeded);

    return {
      address,
      rating,
      reportCount: active.length + (entry.seeded ? 1 : 0),
      uniqueReporters: new Set(active.map((r) => r.reporter)).size,
      reasons: entry.seeded
        ? ['known-bad seed', ...active.map((r) => r.reason)]
        : active.map((r) => r.reason),
      evidenceHashes: active.map((r) => r.evidenceHash),
      lastReportedAt: entry.lastReportedAt || null,
    };
  }

  /** All entries with a non-allow rating. */
  flagged(): BlocklistQueryResult[] {
    const now = this.clock();
    const results: BlocklistQueryResult[] = [];
    for (const entry of this.entries.values()) {
      const rating = computeRating(entry, now);
      if (rating !== 'allow') {
        results.push(this.query(entry.address));
      }
    }
    return results;
  }

  /** Total number of tracked addresses (including allow ones that received a report). */
  size(): number {
    return this.entries.size;
  }

  /** Export raw entries for persistence. */
  snapshot(): BlocklistEntry[] {
    return [...this.entries.values()];
  }

  /** Restore from a snapshot. */
  restore(entries: BlocklistEntry[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.address, entry);
    }
  }
}

/**
 * The process-wide shared instance.
 *
 * Import this wherever cross-vault sharing is needed. Tests construct their own
 * `new Blocklist()` for isolation.
 */
export const sharedBlocklist = new Blocklist();
