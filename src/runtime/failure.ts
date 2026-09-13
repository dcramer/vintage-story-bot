import type { Outcome } from './goal.ts';

export type FailureOutcome = Exclude<Outcome, 'done'>;

const refused = new Set([
  'bridge_unavailable',
  'bridge_timeout',
  'bridge_closed',
  'expired',
  'stalled',
  'gameplay_interruption',
  'start_unsupported',
  'capability_missing',
  'navigation_unavailable',
  'control_lost',
]);
const noProgress = new Set([
  'no_progress',
  'deadline',
  'exploration_exhausted',
  'no_observed_route',
  'no_visible_route',
  'route_blocked',
  'no_route',
  'no_rough_route',
  'lost_support',
  'replan',
]);

export function failureOutcome(code?: string): FailureOutcome {
  if (code === 'cancelled') return 'interrupted';
  if (refused.has(code)) return 'refused';
  if (noProgress.has(code)) return 'no_progress';
  return 'failed';
}

// Codes and outcomes carry behavior; messages remain readable context.
export class GoalError extends Error {
  code: string;
  outcome: FailureOutcome;
  constructor(code: string, message: string, outcome = failureOutcome(code), options?: ErrorOptions) {
    super(message, options);
    this.name = 'GoalError';
    this.code = code;
    this.outcome = outcome;
  }
}
