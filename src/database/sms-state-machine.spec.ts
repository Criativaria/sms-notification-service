import {
  assertValidTransition,
  InvalidStateTransitionError,
  isSameState,
  isTerminal,
  isValidTransition,
  sourceStatesOf,
  type SmsStatus,
} from './sms-state-machine';

const validTransitions: Array<[SmsStatus, SmsStatus]> = [
  ['QUEUED', 'PROCESSING'],
  ['RETRY_SCHEDULED', 'PROCESSING'],
  ['PROCESSING', 'AWAITING_PROVIDER_RESULT'],
  ['AWAITING_PROVIDER_RESULT', 'SENT'],
  ['AWAITING_PROVIDER_RESULT', 'DELIVERED'],
  ['AWAITING_PROVIDER_RESULT', 'UNDELIVERED'],
  ['AWAITING_PROVIDER_RESULT', 'REJECTED'],
  ['AWAITING_PROVIDER_RESULT', 'PROCESSING'],
  ['PROCESSING', 'RETRY_SCHEDULED'],
  ['PROCESSING', 'REJECTED'],
  ['PROCESSING', 'UNDELIVERED'],
  ['PROCESSING', 'FATAL_FAILURE'],
  ['SENT', 'DELIVERED'],
  ['SENT', 'UNDELIVERED'],
  ['SENT', 'REJECTED'],
];

const terminalStates: SmsStatus[] = ['DELIVERED', 'FATAL_FAILURE', 'REJECTED', 'UNDELIVERED'];

const allStates: SmsStatus[] = [
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'AWAITING_PROVIDER_RESULT',
  'SENT',
  'DELIVERED',
  'UNDELIVERED',
  'REJECTED',
  'FATAL_FAILURE',
];

describe('sms-state-machine', () => {
  describe('isValidTransition', () => {
    it.each(validTransitions)('permits %s -> %s', (from, to) => {
      expect(isValidTransition(from, to)).toBe(true);
    });

    it('rejects every transition not in the table', () => {
      const validSet = new Set(validTransitions.map(([from, to]) => `${from}->${to}`));
      for (const from of allStates) {
        for (const to of allStates) {
          if (validSet.has(`${from}->${to}`)) {
            continue;
          }
          expect(isValidTransition(from, to)).toBe(false);
        }
      }
    });

    it('never treats a self-transition as valid, including terminal repeats', () => {
      for (const status of allStates) {
        expect(isValidTransition(status, status)).toBe(false);
      }
    });

    it('forbids a queued message from jumping straight to a terminal delivery state', () => {
      expect(isValidTransition('QUEUED', 'DELIVERED')).toBe(false);
      expect(isValidTransition('QUEUED', 'SENT')).toBe(false);
    });

    it('does not let the worker path (PROCESSING) reach DELIVERED directly', () => {
      expect(isValidTransition('PROCESSING', 'DELIVERED')).toBe(false);
    });

    it('requires a durable provider reservation before a message can become SENT', () => {
      expect(isValidTransition('PROCESSING', 'SENT')).toBe(false);
      expect(isValidTransition('AWAITING_PROVIDER_RESULT', 'SENT')).toBe(true);
    });
  });

  describe('isTerminal', () => {
    it.each(terminalStates)('treats %s as terminal', (status) => {
      expect(isTerminal(status)).toBe(true);
      for (const to of allStates) {
        expect(isValidTransition(status, to)).toBe(false);
      }
    });

    it.each([
      'QUEUED',
      'PROCESSING',
      'RETRY_SCHEDULED',
      'AWAITING_PROVIDER_RESULT',
      'SENT',
    ] as SmsStatus[])('treats %s as non-terminal', (status) => {
      expect(isTerminal(status)).toBe(false);
    });
  });

  describe('isSameState', () => {
    it('is true only for identical statuses', () => {
      expect(isSameState('DELIVERED', 'DELIVERED')).toBe(true);
      expect(isSameState('SENT', 'DELIVERED')).toBe(false);
    });
  });

  describe('assertValidTransition', () => {
    it('does not throw for a valid transition', () => {
      expect(() => assertValidTransition('QUEUED', 'PROCESSING')).not.toThrow();
    });

    it('throws a typed error carrying both endpoints for an invalid transition', () => {
      expect.assertions(3);
      try {
        assertValidTransition('DELIVERED', 'SENT');
      } catch (error) {
        expect(error).toBeInstanceOf(InvalidStateTransitionError);
        expect((error as InvalidStateTransitionError).from).toBe('DELIVERED');
        expect((error as InvalidStateTransitionError).to).toBe('SENT');
      }
    });
  });

  describe('sourceStatesOf', () => {
    it('lists every structural predecessor of PROCESSING', () => {
      // Includes AWAITING_PROVIDER_RESULT (the internal release performed by
      // finalizeProviderAttempt on a definitive failure). NOTE: SmsLifecycleRepository's
      // worker-entry-point `beginProcessing` deliberately uses a narrower, explicit list
      // (QUEUED, RETRY_SCHEDULED only) rather than this raw structural lookup, so a message
      // holding an outstanding provider reservation can never be re-claimed as a fresh job.
      expect(new Set(sourceStatesOf('PROCESSING'))).toEqual(
        new Set(['QUEUED', 'RETRY_SCHEDULED', 'AWAITING_PROVIDER_RESULT']),
      );
    });

    it('lists the states a delivery webhook can move to DELIVERED from', () => {
      expect(sourceStatesOf('DELIVERED')).toEqual(['AWAITING_PROVIDER_RESULT', 'SENT']);
    });

    it('includes PROCESSING, SENT, and the ambiguous reservation as sources of UNDELIVERED', () => {
      expect(new Set(sourceStatesOf('UNDELIVERED'))).toEqual(
        new Set(['AWAITING_PROVIDER_RESULT', 'PROCESSING', 'SENT']),
      );
    });

    it('returns no sources for QUEUED', () => {
      expect(sourceStatesOf('QUEUED')).toEqual([]);
    });
  });
});
