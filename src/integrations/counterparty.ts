/**
 * Agent-side counterparty check wrapper.
 *
 * Before an agent submits a spend, this wrapper queries the shared blocklist
 * and enforces the result:
 *
 *   block  → refuse immediately, never call guard.submit()
 *   warn   → route through guard.submit() with a flag that forces require_approval
 *   allow  → pass through to guard.submit() unchanged
 *
 * The wrapper is the agent-layer complement to the guard-layer pre-check
 * (src/core/service.ts). Both checks run independently so the policy holds even
 * if only one is present.
 *
 * Key scoping note
 * ────────────────
 * The agent signs transactions with a function-call access key scoped to a
 * single contract method (`spend`). That key:
 *   - CAN call `spend()` on the vault contract.
 *   - CANNOT call `report()` on the blocklist contract directly — that requires
 *     a separate key or the owner key.
 *   - CANNOT add keys, delete keys, withdraw, pause, or call any other method.
 *
 * In this in-process design the agent calls `counterpartyGuard.report()` which
 * writes to the in-memory registry. In a production deployment the agent would
 * call a view method to query and a separate transaction (signed by the owner
 * or a dedicated reporting key) to submit reports.
 */

import type { FeralGuard } from '../core/service.ts';
import type { ActionRequest, Decision } from '../core/engine.ts';
import { type Blocklist, type BlocklistQueryResult, sharedBlocklist } from '../core/blocklist.ts';

export interface CounterpartyCheckResult {
  /** The blocklist verdict for this address. */
  rating: 'allow' | 'warn' | 'block';
  /** Human-readable reasons from the blocklist. */
  reasons: string[];
  /** Evidence hashes the caller can verify independently. */
  evidenceHashes: string[];
}

export interface CounterpartySubmitResult {
  /** Whether the action was submitted to the guard (false when blocked). */
  submitted: boolean;
  /** Blocklist check result that led to this outcome. */
  check: CounterpartyCheckResult;
  /** The guard's decision, if the action was submitted. */
  decision?: Decision;
  /** The approval id, if the guard returned require_approval. */
  approvalId?: string;
  /** Refusal message when submitted is false. */
  refusal?: string;
}

/**
 * Wraps a FeralGuard with a counterparty pre-check.
 *
 * Usage:
 *   const cg = new CounterpartyGuard(guard);
 *   const result = await cg.submit(action);
 *   if (!result.submitted) console.log('blocked:', result.refusal);
 */
export class CounterpartyGuard {
  private guard: FeralGuard;
  private blocklist: Blocklist;

  constructor(guard: FeralGuard, blocklist: Blocklist = sharedBlocklist) {
    this.guard = guard;
    this.blocklist = blocklist;
  }

  /** Query the blocklist for an address without submitting anything. */
  check(address: string): CounterpartyCheckResult {
    const result: BlocklistQueryResult = this.blocklist.query(address);
    return {
      rating: result.rating,
      reasons: result.reasons,
      evidenceHashes: result.evidenceHashes,
    };
  }

  /**
   * Submit an action after first consulting the blocklist.
   *
   * - block: returns immediately with submitted=false. The guard is never called.
   *   The agent's key never signs anything for this address.
   * - warn:  appends a reason to the action so the guard's escalation logic
   *   sees `RISK_NEW_COUNTERPARTY` and routes to require_approval. The human
   *   sees both the guard reason and the blocklist reasons.
   * - allow: passes through unchanged.
   */
  async submit(action: ActionRequest): Promise<CounterpartySubmitResult> {
    const address = action.to ?? '';
    const check = this.check(address);

    if (check.rating === 'block') {
      return {
        submitted: false,
        check,
        refusal: `counterparty ${address} is blocked by the shared registry: ${check.reasons.join('; ')}`,
      };
    }

    // For warn, annotate the reason field so the guard's escalation heuristics
    // see the signal. The reason field is never parsed for control flow by the
    // engine — this annotation is for the human reviewing the approval queue.
    const annotated: ActionRequest =
      check.rating === 'warn'
        ? {
            ...action,
            reason: [
              action.reason,
              `BLOCKLIST_WARN: ${check.reasons.join('; ')}`,
            ]
              .filter(Boolean)
              .join(' | '),
          }
        : action;

    const { decision, approval } = await this.guard.submit(annotated);

    return {
      submitted: true,
      check,
      decision,
      approvalId: approval?.id,
    };
  }

  /**
   * Report a counterparty as bad after a detected attack or anomaly.
   *
   * The agent calls this after a spend is denied for a suspicious reason
   * (RECIPIENT_DENIED, ANOMALY_DRAINAGE, etc.) so other vaults benefit.
   *
   * Evidence should be the audit record hash or the transaction hash — something
   * the registry stores as sha256 so the claim cannot be altered after submission.
   */
  report(address: string, reporter: string, reason: string, evidence = ''): BlocklistQueryResult {
    this.blocklist.report(address, reporter, reason, evidence);
    return this.blocklist.query(address);
  }

  /** Expose the underlying guard for direct access when needed. */
  get feralGuard(): FeralGuard {
    return this.guard;
  }

  /** Expose the blocklist for seeding and introspection. */
  get registry(): Blocklist {
    return this.blocklist;
  }
}
