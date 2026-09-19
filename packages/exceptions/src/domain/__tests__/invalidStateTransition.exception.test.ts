import { describe, expect, it } from 'vitest';

import { BaseDomainException, BaseException, INVALID_STATE_TRANSITION } from '../../common';
import { InvalidStateTransitionException } from '../invalidStateTransition.exception';

/**
 * TASK-992 — the exception that replaces a bare `BusinessException` on the
 * `TranscriptionJob` state machine.
 *
 * Its whole reason to exist is that the STT worker, in another process and
 * another language, must be able to tell "you cannot start this, ever" from
 * "you cannot start this yet" WITHOUT parsing prose. Before this, both arrived
 * as `500 { code: 'DOMAIN.BUSINESS', message: 'Cannot start job in … status' }`
 * and the worker matched on the substring `"Cannot start job in"`, which
 * classified a recoverable `PROCESSING` as terminal and orphaned the job.
 *
 * So the two assertions that matter here are structural: a code distinct from
 * every other business refusal, and a `terminal` boolean the gateway decides —
 * never a status string the caller has to re-interpret.
 */
describe('InvalidStateTransitionException', () => {
  const metadata = {
    entity: 'TranscriptionJob',
    entityId: '01a0b94c-637e-78c0-a279-3a83cf8df46b',
    currentStatus: 'PROCESSING',
    attempted: 'startProcessing',
    terminal: false,
  };

  it('carries its own code, distinct from DOMAIN.BUSINESS', () => {
    const error = new InvalidStateTransitionException('Cannot start job in PROCESSING status', metadata);

    expect(error.code).toBe(INVALID_STATE_TRANSITION);
    expect(error.code).toBe('DOMAIN.INVALID_STATE_TRANSITION');
    expect(error.code).not.toBe('DOMAIN.BUSINESS');
  });

  it('serialises the transition detail so a cross-process caller never parses the message', () => {
    const error = new InvalidStateTransitionException('Cannot start job in PROCESSING status', metadata);
    const json = error.toJSON();

    expect(json.code).toBe('DOMAIN.INVALID_STATE_TRANSITION');
    expect(json.metadata).toEqual(metadata);
  });

  it('distinguishes a recoverable refusal from a genuinely terminal one', () => {
    const recoverable = new InvalidStateTransitionException('Cannot start job in PROCESSING status', metadata);
    const terminal = new InvalidStateTransitionException('Cannot start job in COMPLETED status', {
      ...metadata,
      currentStatus: 'COMPLETED',
      terminal: true,
    });

    expect((recoverable.toJSON().metadata as typeof metadata).terminal).toBe(false);
    expect((terminal.toJSON().metadata as typeof metadata).terminal).toBe(true);
  });

  it('extends BaseDomainException so the gateway interceptor can branch on it', () => {
    const error = new InvalidStateTransitionException('nope', metadata);

    expect(error).toBeInstanceOf(BaseDomainException);
    expect(error).toBeInstanceOf(BaseException);
  });
});
