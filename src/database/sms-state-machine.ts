import type { SmsMessageStatus } from '../generated/prisma/client';

/**
 * Canonical SMS status type, re-exported from the generated Prisma enum so callers
 * (queue worker, webhooks module) can depend on this seam without importing Prisma.
 */
export type SmsStatus = SmsMessageStatus;

/**
 * Thrown when a status transition is not permitted by the lifecycle table.
 * Carries the offending endpoints so callers can map it to an HTTP response or a log
 * line. It never contains PII (no phone numbers, no message bodies).
 */
export class InvalidStateTransitionError extends Error {
  readonly from: SmsStatus;
  readonly to: SmsStatus;

  constructor(from: SmsStatus, to: SmsStatus) {
    super(`Invalid SMS status transition from ${from} to ${to}`);
    this.name = 'InvalidStateTransitionError';
    this.from = from;
    this.to = to;
  }
}

const noTransitions: ReadonlySet<SmsStatus> = new Set<SmsStatus>();

/**
 * The single source of truth for valid SMS lifecycle transitions. Every status maps to
 * the set of statuses it may move to; an empty set marks a terminal state.
 */
const transitionTable: Readonly<Record<SmsStatus, ReadonlySet<SmsStatus>>> = {
  QUEUED: new Set<SmsStatus>(['PROCESSING']),
  RETRY_SCHEDULED: new Set<SmsStatus>(['PROCESSING']),
  PROCESSING: new Set<SmsStatus>([
    'AWAITING_PROVIDER_RESULT',
    'RETRY_SCHEDULED',
    'REJECTED',
    'UNDELIVERED',
    'FATAL_FAILURE',
  ]),
  // A provider invocation has been durably reserved. A definitive result (success or a
  // clean provider response) can advance or release it; an ambiguous result (timeout/no
  // response) leaves it here for audited operator resolution — never an automatic retry.
  AWAITING_PROVIDER_RESULT: new Set<SmsStatus>(['SENT', 'UNDELIVERED', 'PROCESSING']),
  // SENT may only advance via delivery webhooks.
  SENT: new Set<SmsStatus>(['DELIVERED', 'UNDELIVERED', 'REJECTED']),
  // Terminal states: no outgoing transitions.
  DELIVERED: noTransitions,
  FATAL_FAILURE: noTransitions,
  REJECTED: noTransitions,
  UNDELIVERED: noTransitions,
};

function outgoing(from: SmsStatus): ReadonlySet<SmsStatus> {
  return transitionTable[from] ?? noTransitions;
}

/** True when `to` is a permitted next status from `from`. */
export function isValidTransition(from: SmsStatus, to: SmsStatus): boolean {
  return outgoing(from).has(to);
}

/** True when both endpoints are the same status (a repeat callback / re-processing). */
export function isSameState(from: SmsStatus, to: SmsStatus): boolean {
  return from === to;
}

/** True when `status` has no outgoing transitions. */
export function isTerminal(status: SmsStatus): boolean {
  return outgoing(status).size === 0;
}

/** Throws {@link InvalidStateTransitionError} when the transition is not permitted. */
export function assertValidTransition(from: SmsStatus, to: SmsStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/**
 * Reverse lookup: the set of statuses that may transition INTO `to`. Used by the
 * repository to build optimistic-concurrency `where` clauses straight from the table,
 * so the guard and the conditional update can never drift apart.
 */
export function sourceStatesOf(to: SmsStatus): SmsStatus[] {
  const sources: SmsStatus[] = [];
  for (const status of Object.keys(transitionTable) as SmsStatus[]) {
    if (outgoing(status).has(to)) {
      sources.push(status);
    }
  }
  return sources;
}
