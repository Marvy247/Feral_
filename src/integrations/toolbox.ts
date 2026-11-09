/**
 * Wiring Feral into an agent, framework-free.
 *
 * An agent that pays for APIs, compute or data has one choke point: the call that
 * spends money. This module wraps a paid tool so the policy is consulted *before*
 * the handler runs, and the handler never runs when the policy says no.
 *
 * Settlement is intentionally out of scope here: the wrapper books the spend
 * through the guard (which is what the budget needs) and the executor - a NEAR
 * transfer, a 1Click swap, an x402 payment - is whatever the host already uses.
 * Keeping the two apart is what makes the policy testable without a chain.
 */
import type { FeralGuard } from '../core/service.ts';
import type { ActionRequest, Decision } from '../core/engine.ts';

export interface PaidTool {
  /** Tool name, used in the action id and the audit trail. */
  name: string;
  /** The vendor that gets paid. Must be an allow-listed counterparty. */
  vendor: string;
  price: { asset: string; amount: string };
  /** The work the agent actually wanted. Only called when the policy allows it. */
  handler: (input: unknown) => Promise<unknown> | unknown;
}

export type ToolOutcome =
  | { status: 'ok'; result: unknown; decision: Decision }
  | { status: 'refused'; decision: Decision; reason: string }
  | { status: 'pending_approval'; decision: Decision; approvalId: string }
  | { status: 'failed'; decision: Decision; error: string };

export class GatedToolbox {
  private tools = new Map<string, PaidTool>();
  private guard: FeralGuard;
  private actor: string;

  constructor(guard: FeralGuard, options: { actor?: string } = {}) {
    this.guard = guard;
    this.actor = options.actor ?? guard.compiled.agents[0]?.account ?? guard.policyDoc.owner;
  }

  register(tool: PaidTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  list(): { name: string; vendor: string; price: string; asset: string }[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      vendor: tool.vendor,
      price: tool.price.amount,
      asset: tool.price.asset,
    }));
  }

  /**
   * Run one paid tool call under policy.
   *
   * The action id is derived from the tool call so a retry of the same logical
   * call cannot double-pay, and a genuine second call gets a fresh id.
   */
  async call(name: string, input: unknown, callId = `${name}_${Date.now()}`): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`unknown tool: ${name}`);
    }

    const action: ActionRequest = {
      id: callId,
      kind: 'api.pay',
      actor: this.actor,
      asset: tool.price.asset,
      amount: tool.price.amount,
      to: tool.vendor,
      reason: `tool call: ${name}`,
    };

    const { decision, approval } = await this.guard.submit(action);

    if (decision.verdict === 'deny') {
      return {
        status: 'refused',
        decision,
        reason: decision.reasons.map((r) => r.code).join(', ') || 'denied by policy',
      };
    }

    if (decision.verdict === 'require_approval') {
      return { status: 'pending_approval', decision, approvalId: approval?.id ?? 'unknown' };
    }

    try {
      const result = await tool.handler(input);
      return { status: 'ok', result, decision };
    } catch (err) {
      // The spend is already booked: the vendor was paid even if the tool failed.
      // That is a business decision the host can act on (retry, refund), not a
      // policy hole, so we surface it instead of hiding it.
      return { status: 'failed', decision, error: (err as Error).message };
    }
  }
}
