/**
 * Harness-progress reducer tests (TASK-345).
 *
 * The SSE relay (`/consultations/:id/harness-progress/stream`) delivers
 * full-state `HarnessProgressEventDto` JSON messages, interleaved with
 * heartbeats. `reduceHarnessProgressMessage` classifies each raw payload and
 * `normalizeHarnessProgressEvent` coerces it defensively so the checklist can
 * never render NaN ordinals / unknown statuses from a malformed payload.
 */
import { describe, it, expect } from 'vitest';
import { normalizeHarnessProgressEvent, reduceHarnessProgressMessage } from '../harness-progress';

const stage = (overrides: Record<string, unknown> = {}) => ({
  stage: 'extracting_information',
  label: 'Extracting key information',
  ordinal: 1,
  status: 'active',
  attempt: 1,
  at: '2026-06-10T03:00:00.000Z',
  ...overrides,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  consultationId: 'c-1',
  jobId: 'harness-doc-1',
  total: 5,
  stages: [stage()],
  updatedAt: '2026-06-10T03:00:00.000Z',
  closed: false,
  ...overrides,
});

describe('reduceHarnessProgressMessage', () => {
  it('classifies a progress payload as an event with its stages', () => {
    const message = reduceHarnessProgressMessage(JSON.stringify(event()));

    expect(message.kind).toBe('event');
    if (message.kind !== 'event') throw new Error('expected event');
    expect(message.event.consultationId).toBe('c-1');
    expect(message.event.total).toBe(5);
    expect(message.event.stages).toHaveLength(1);
    expect(message.event.stages[0]).toMatchObject({
      stage: 'extracting_information',
      label: 'Extracting key information',
      ordinal: 1,
      status: 'active',
      attempt: 1,
    });
  });

  it('classifies the terminal payload as closed', () => {
    const message = reduceHarnessProgressMessage(
      JSON.stringify(event({ closed: true, stages: [stage({ status: 'completed' })] })),
    );

    expect(message.kind).toBe('closed');
    if (message.kind !== 'closed') throw new Error('expected closed');
    expect(message.event.closed).toBe(true);
    expect(message.event.stages[0].status).toBe('completed');
  });

  it('classifies heartbeats and empty payloads as heartbeat', () => {
    expect(reduceHarnessProgressMessage(JSON.stringify({ type: 'heartbeat', ts: 'now' })).kind).toBe('heartbeat');
    expect(reduceHarnessProgressMessage('').kind).toBe('heartbeat');
    expect(reduceHarnessProgressMessage('   ').kind).toBe('heartbeat');
    expect(reduceHarnessProgressMessage('{}').kind).toBe('heartbeat');
  });

  it('classifies unparseable / non-object payloads as invalid (never throws)', () => {
    expect(reduceHarnessProgressMessage('not-json{').kind).toBe('invalid');
    expect(reduceHarnessProgressMessage('"a string"').kind).toBe('invalid');
    expect(reduceHarnessProgressMessage('42').kind).toBe('invalid');
  });
});

describe('normalizeHarnessProgressEvent', () => {
  it('drops malformed stage entries and defaults missing stage fields', () => {
    const normalized = normalizeHarnessProgressEvent(
      event({
        stages: [
          stage(),
          { stage: 'drafting_note' }, // minimal: gets label/ordinal/status/attempt defaults
          { label: 'no stage key' }, // no stage key → dropped
          'nonsense', // not an object → dropped
        ],
      }) as Record<string, unknown>,
    );

    expect(normalized.stages).toHaveLength(2);
    expect(normalized.stages[1]).toEqual({
      stage: 'drafting_note',
      label: 'drafting_note',
      ordinal: 2,
      status: 'pending',
      attempt: 1,
      at: '',
    });
  });

  it('coerces an unknown status to pending and keeps stages sorted by ordinal', () => {
    const normalized = normalizeHarnessProgressEvent(
      event({
        stages: [
          stage({ stage: 'b', ordinal: 2, status: 'exploded' }),
          stage({ stage: 'a', ordinal: 1, status: 'completed' }),
        ],
      }) as Record<string, unknown>,
    );

    expect(normalized.stages.map((s) => s.stage)).toEqual(['a', 'b']);
    expect(normalized.stages[1].status).toBe('pending');
  });
});
