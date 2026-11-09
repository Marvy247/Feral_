/**
 * An agent that adapts to refusals instead of being stopped by them.
 *
 * The interesting part of a policy firewall is not the refusal, it is what happens
 * next: a reason code is a machine-readable explanation, so the agent can choose a
 * legal way to get its work done instead of either giving up or asking a human to
 * widen a limit. That behaviour belongs to the agent, not to the firewall - this
 * module is the agent half, written once so it can be tested.
 *
 * The loop never widens a limit, never retries the same call, and gives up after a
 * bounded number of attempts. Everything it does goes through `GatedToolbox`, so every
 * attempt is judged by the same policy and lands in the same audit chain.
 */
import type { Decision } from '../core/engine.ts';
import type { GatedToolbox, ToolOutcome } from './toolbox.ts';

/** A candidate way to accomplish the task, cheapest last is up to the caller. */
export interface PlanStep {
  /** Tool to call. Must be registered on the toolbox. */
  tool: string;
  /** Human-readable note about why this step exists. */
  why: string;
}

export interface Attempt {
  step: PlanStep;
  outcome: ToolOutcome['status'];
  codes: string[];
  detail: string;
}

export interface TaskReport {
  task: string;
  attempts: Attempt[];
  status: 'done' | 'gave_up' | 'blocked_on_human';
  spent: Attempt | null;
}

const codesOf = (decision: Decision): string[] => decision.reasons.map((reason) => reason.code);

/**
 * How to react to a refusal. A reason code the agent cannot handle means stop, not
 * retry harder: guessing is how agents burn budgets.
 */
export function nextStepAfterRefusal(codes: readonly string[], plan: readonly PlanStep[], attemptIndex: number): PlanStep | null {
  const next = plan[attemptIndex + 1];
  if (!next) return null;
  // A wall that has nothing to do with the amount will not be fixed by a cheaper tier.
  const hardStops = ['POLICY_PAUSED', 'POLICY_EXPIRED', 'ACTION_NOT_ALLOWED', 'RECIPIENT_DENIED', 'REPLAY', 'INVALID_ACTION'];
  if (codes.some((code) => hardStops.includes(code))) return null;
  return next;
}

export async function runTask(
  toolbox: GatedToolbox,
  task: string,
  plan: readonly PlanStep[],
  options: { maxAttempts?: number } = {},
): Promise<TaskReport> {
  const maxAttempts = options.maxAttempts ?? plan.length;
  const attempts: Attempt[] = [];
  let index = 0;

  while (index < plan.length && attempts.length < maxAttempts) {
    const step = plan[index];
    const outcome = await toolbox.call(step.tool, { task }, `${step.tool}_${attempts.length}`);
    const codes = codesOf(outcome.decision);

    attempts.push({
      step,
      outcome: outcome.status,
      codes,
      detail:
        outcome.status === 'ok'
          ? 'ran'
          : outcome.status === 'refused'
            ? outcome.reason
            : outcome.status === 'pending_approval'
              ? 'waiting for the owner'
              : outcome.error,
    });

    if (outcome.status === 'ok') {
      return { task, attempts, status: 'done', spent: attempts[attempts.length - 1] };
    }
    if (outcome.status === 'pending_approval') {
      return { task, attempts, status: 'blocked_on_human', spent: null };
    }

    const next = nextStepAfterRefusal(codes, plan, index);
    if (!next) return { task, attempts, status: 'gave_up', spent: null };
    index = plan.indexOf(next);
  }

  return { task, attempts, status: 'gave_up', spent: null };
}

/** One line per attempt, for a terminal or a log. */
export function formatTrace(report: TaskReport): string {
  const lines = [`task: ${report.task}`];
  for (const [index, attempt] of report.attempts.entries()) {
    const verdict = attempt.outcome === 'ok' ? 'ok' : attempt.outcome;
    lines.push(
      `  ${index + 1}. ${attempt.step.tool.padEnd(18)} ${verdict.padEnd(17)} ${attempt.codes.join(', ') || attempt.detail}`,
    );
    lines.push(`     why this step: ${attempt.step.why}`);
  }
  lines.push(`  result: ${report.status}`);
  return lines.join('\n');
}
