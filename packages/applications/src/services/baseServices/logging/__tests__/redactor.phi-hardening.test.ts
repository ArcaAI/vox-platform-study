/**
 * PHI hardening of the backend redactor.
 *
 * - `error.cause` is a non-enumerable own property, so the old walker never
 *   looked at it, and a clean outer error handed its PHI-bearing cause straight
 *   to the transport's `formatError`.
 * - Key-only redaction misses PHI that arrives inside a string: an email in a
 *   message, a bearer token or JWT echoed by an HTTP client error.
 * - Clinical identifiers are hashed with `redactId` (same algorithm as the
 *   Python fleet) instead of blanked, so a line stays correlatable.
 */

import { describe, expect, it } from 'vitest';

import { redactId } from '../redact-id';
import { REDACTED_VALUE, redactEntry, redactValue } from '../redactor';
import type { LogEntry } from '../transports/types';

const base: LogEntry = {
  level: 'error',
  levelNumber: 50,
  message: 'x',
  timestamp: '2026-09-29T00:00:00.000Z',
  timestampMs: 1790000000000,
};

describe('error.cause', () => {
  it('redacts a PHI key inside a cause and keeps the cause on the clone', () => {
    const inner = Object.assign(new Error('db said no'), { transcript: 'patient said...' });
    const outer = new Error('outer', { cause: inner });

    const out = redactValue(outer) as Error & { cause?: Error & { transcript?: string } };

    expect(out).toBeInstanceOf(Error);
    expect(out).not.toBe(outer);
    expect(out.cause).toBeInstanceOf(Error);
    expect(out.cause?.transcript).toBe(REDACTED_VALUE);
    expect(out.cause?.message).toBe('db said no');
    expect(inner.transcript).toBe('patient said...');
  });

  it('walks the chain recursively', () => {
    const deepest = new Error('reached jane.doe@example.com');
    const mid = new Error('mid', { cause: deepest });
    const top = new Error('top', { cause: mid });

    const out = redactValue(top) as Error & { cause: Error & { cause: Error } };

    expect(out.cause.cause.message).not.toContain('jane.doe@example.com');
  });

  it('caps the walk depth and never recurses forever on a self-referencing cause', () => {
    const loop = new Error('loop') as Error & { cause?: unknown };
    loop.cause = loop;

    expect(() => redactValue(loop)).not.toThrow();
  });

  it('a clean cause chain keeps the original error instance', () => {
    const err = new Error('outer', { cause: new Error('inner') });

    expect(redactValue(err)).toBe(err);
  });

  it('preserves name, code and status on a rebuilt error', () => {
    const err = Object.assign(new Error('boom', { cause: new Error('x', { cause: undefined }) }), {
      name: 'UpstreamError',
      code: 'UPSTREAM_TIMEOUT',
      status: 504,
      patientId: 'P-1',
    });

    const out = redactValue(err) as Error & { code?: string; status?: number };

    expect(out.name).toBe('UpstreamError');
    expect(out.code).toBe('UPSTREAM_TIMEOUT');
    expect(out.status).toBe(504);
  });

  it('redactEntry redacts the cause of entry.error', () => {
    const cause = Object.assign(new Error('inner'), { patientName: 'Jane Doe' });
    const out = redactEntry({ ...base, error: new Error('outer', { cause }) });

    const outCause = (out.error as Error).cause as Error & { patientName?: string };
    expect(outCause.patientName).toBe(REDACTED_VALUE);
  });
});

describe('value-pattern scrubbing', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';

  it('scrubs an email address from the message', () => {
    const out = redactEntry({ ...base, message: 'no user jane.doe+x@example.co.uk found' });

    expect(out.message).not.toContain('jane.doe');
    expect(out.message).toContain('no user');
  });

  it('scrubs a JWT from the message', () => {
    const out = redactEntry({ ...base, message: `bad token ${jwt} rejected` });

    expect(out.message).not.toContain(jwt);
    expect(out.message).toContain('rejected');
  });

  it('scrubs a bearer token from the message', () => {
    const out = redactEntry({ ...base, message: 'upstream said: Authorization: Bearer abc.DEF-123_xyz' });

    expect(out.message).not.toContain('abc.DEF-123_xyz');
  });

  it('scrubs patterns in string meta values and error messages', () => {
    const out = redactEntry({
      ...base,
      meta: { detail: 'contact a@b.io' },
      error: new Error(`jwt ${jwt}`),
    });

    expect((out.meta as { detail: string }).detail).not.toContain('a@b.io');
    expect((out.error as Error).message).not.toContain(jwt);
    expect((out.error as Error).stack ?? '').not.toContain(jwt);
  });

  it('leaves operational strings alone', () => {
    const clean = { route: '/api/v1/consultations/:id', pkg: '@arcaai/ui', version: 'foo@1.2.3', status: 'ok' };

    expect(redactValue(clean)).toBe(clean);
  });
});

describe('added PHI / credential keys', () => {
  it.each([
    'cookie',
    'set-cookie',
    'x-service-token',
    'x-api-key',
    'authorization',
    'firstName',
    'lastName',
    'fullName',
    'dateOfBirth',
    'dob',
    'address',
    'phone',
    'phoneNumber',
    'phone_number',
    'transcript',
    'prompt',
    'completion',
  ])('%s is redacted', (key) => {
    const out = redactValue({ [key]: 'sensitive' }) as Record<string, unknown>;

    expect(out[key]).toBe(REDACTED_VALUE);
  });

  it.each(['text', 'body', 'content', 'name'])('%s is NOT redacted (too broad, operational)', (key) => {
    const input = { [key]: 'value' };

    expect(redactValue(input)).toBe(input);
  });
});

describe('clinical identifiers are hashed, correlation ids stay raw', () => {
  it.each(['patientId', 'externalPatientId', 'consultationId', 'patient_id', 'ConsultationId'])('%s -> redactId', (key) => {
    const out = redactValue({ [key]: 'P-1' }) as Record<string, unknown>;

    expect(out[key]).toBe(redactId('P-1'));
  });

  it('a non-scalar under an id key is blanked, not hashed', () => {
    const out = redactValue({ patientId: { nested: 'x' } }) as Record<string, unknown>;

    expect(out.patientId).toBe(REDACTED_VALUE);
  });

  it('tenantId / userId / traceId / requestId stay raw', () => {
    const input = { tenantId: 't-1', userId: 'u-1', traceId: 'a'.repeat(32), requestId: 'r-1' };

    expect(redactValue(input)).toBe(input);
  });

  it('mrn stays fully redacted (low-entropy: an unsalted hash is reversible)', () => {
    const out = redactValue({ mrn: '000042' }) as Record<string, unknown>;

    expect(out.mrn).toBe(REDACTED_VALUE);
  });
});
