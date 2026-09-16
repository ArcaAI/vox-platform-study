import { describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  HopeAPIError,
  NotFoundError,
  PermissionError,
  PreconditionRequiredError,
  QuotaExceededError,
  RateLimitError,
  VersionConflictError,
  fromResponse,
} from '../errors';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('fromResponse — status → class mapping', () => {
  it('maps 401 to AuthenticationError', () => {
    const err = fromResponse(jsonResponse(401, { message: 'Unauthorized' }), { message: 'Unauthorized' });
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(HopeAPIError);
    expect(err.status).toBe(401);
  });

  it('maps 403 to PermissionError', () => {
    const err = fromResponse(jsonResponse(403, { message: 'Forbidden' }), { message: 'Forbidden' });
    expect(err).toBeInstanceOf(PermissionError);
    expect(err.status).toBe(403);
  });

  it('maps 404 to NotFoundError', () => {
    const err = fromResponse(jsonResponse(404, { message: 'Resource not found' }), {
      message: 'Resource not found',
    });
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err.status).toBe(404);
  });

  it('maps 409 to QuotaExceededError', () => {
    const err = fromResponse(jsonResponse(409, { message: 'Quota exceeded' }), { message: 'Quota exceeded' });
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err.status).toBe(409);
  });

  it('maps 412 to VersionConflictError and exposes currentVersion', () => {
    const body = {
      message: 'Version conflict',
      code: 'PERSISTENCE.CONCURRENCY_CONFLICT',
      metadata: { expectedVersion: 3, currentVersion: 5 },
    };
    const err = fromResponse(jsonResponse(412, body), body);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err.status).toBe(412);
    expect((err as VersionConflictError).currentVersion).toBe(5);
    expect(err.code).toBe('PERSISTENCE.CONCURRENCY_CONFLICT');
  });

  it('leaves currentVersion undefined when the body carries no metadata', () => {
    const err = fromResponse(jsonResponse(412, { message: 'Version conflict' }), { message: 'Version conflict' });
    expect((err as VersionConflictError).currentVersion).toBeUndefined();
  });

  it('maps 428 to PreconditionRequiredError', () => {
    const err = fromResponse(jsonResponse(428, { message: 'If-Match required' }), {
      message: 'If-Match required',
    });
    expect(err).toBeInstanceOf(PreconditionRequiredError);
    expect(err.status).toBe(428);
  });

  it('maps 429 to RateLimitError and exposes retryAfter parsed from the header (delta-seconds)', () => {
    const res = jsonResponse(429, { message: 'Too many requests' }, { 'retry-after': '30' });
    const err = fromResponse(res, { message: 'Too many requests' });
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.status).toBe(429);
    expect((err as RateLimitError).retryAfterMs).toBe(30_000);
  });

  it('leaves retryAfterMs undefined when there is no Retry-After header', () => {
    const err = fromResponse(jsonResponse(429, { message: 'Too many requests' }), {
      message: 'Too many requests',
    });
    expect((err as RateLimitError).retryAfterMs).toBeUndefined();
  });

  it('falls back to the generic HopeAPIError for an unmapped status', () => {
    const err = fromResponse(jsonResponse(500, { message: 'boom' }), { message: 'boom' });
    expect(err).toBeInstanceOf(HopeAPIError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
    expect(err.status).toBe(500);
  });

  it('captures the request id from the x-request-id response header', () => {
    const res = jsonResponse(500, { message: 'boom' }, { 'x-request-id': 'req-abc-123' });
    const err = fromResponse(res, { message: 'boom' });
    expect(err.requestId).toBe('req-abc-123');
  });

  it('captures the correlationId from the body when there is no x-request-id header', () => {
    const body = { message: 'boom', correlationId: 'corr-xyz-789' };
    const err = fromResponse(jsonResponse(500, body), body);
    expect(err.requestId).toBe('corr-xyz-789');
  });
});

describe('fromResponse — problems[] (the house { message, code, problems? } shape)', () => {
  it('lifts problems from a 400 body', () => {
    const body = { message: 'Incompatible', code: 'WORKFLOW_CONTEXT_INCOMPATIBLE', problems: ['/referral: not declared in the bound version v2'] };
    const err = fromResponse(jsonResponse(400, body), body);
    expect(err.problems).toEqual(['/referral: not declared in the bound version v2']);
  });

  it('lifts problems for every 4xx status, not only 400', () => {
    for (const status of [401, 403, 404, 409, 412, 428, 429]) {
      const body = { message: 'refused', problems: ['one problem'] };
      const err = fromResponse(jsonResponse(status, body), body);
      expect(err.problems, `status ${status} did not lift problems`).toEqual(['one problem']);
    }
  });

  it('is undefined when the body carries no problems array', () => {
    const body = { message: 'boom' };
    const err = fromResponse(jsonResponse(400, body), body);
    expect(err.problems).toBeUndefined();
  });

  it('is undefined when problems is present but empty', () => {
    const body = { message: 'boom', problems: [] };
    const err = fromResponse(jsonResponse(400, body), body);
    expect(err.problems).toBeUndefined();
  });

  it('drops non-string entries rather than throwing', () => {
    const body = { message: 'boom', problems: ['ok', 42, null, 'also ok'] };
    const err = fromResponse(jsonResponse(400, body), body);
    expect(err.problems).toEqual(['ok', 'also ok']);
  });

  it('is undefined when problems is not an array', () => {
    const body = { message: 'boom', problems: 'not an array' };
    const err = fromResponse(jsonResponse(400, body), body);
    expect(err.problems).toBeUndefined();
  });
});

describe('NotFoundError — 404-over-403 posture', () => {
  it('mentions the cross-tenant possibility in the error message text', () => {
    const err = new NotFoundError({ message: 'Resource not found' });
    expect(err.message).toMatch(/tenant/i);
  });

  it('still carries the server-provided message content, not just the boilerplate', () => {
    const err = new NotFoundError({ message: 'Consultation not found' });
    expect(err.message).toMatch(/Consultation not found/);
    expect(err.message).toMatch(/tenant/i);
  });
});

describe('instanceof correctness across the ESM/CJS boundary', () => {
  it('sets the prototype explicitly so instanceof works after transpilation/bundling', () => {
    const err = new VersionConflictError({ message: 'conflict', currentVersion: 2 });
    // Object.setPrototypeOf(this, new.target.prototype) is what keeps this true
    // even when the error crosses a require()/import() boundary that a naive
    // `class extends Error` implementation can lose under some down-level
    // transpilation targets.
    expect(Object.getPrototypeOf(err)).toBe(VersionConflictError.prototype);
    expect(err instanceof VersionConflictError).toBe(true);
    expect(err instanceof HopeAPIError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it('holds for every subclass', () => {
    const cases: [unknown, Function][] = [
      [new AuthenticationError({ message: 'x' }), AuthenticationError],
      [new PermissionError({ message: 'x' }), PermissionError],
      [new NotFoundError({ message: 'x' }), NotFoundError],
      [new QuotaExceededError({ message: 'x' }), QuotaExceededError],
      [new PreconditionRequiredError({ message: 'x' }), PreconditionRequiredError],
      [new RateLimitError({ message: 'x' }), RateLimitError],
      [new APIConnectionError({}), APIConnectionError],
      [new APITimeoutError({}), APITimeoutError],
    ];
    for (const [instance, ctor] of cases) {
      expect(instance instanceof ctor).toBe(true);
      expect(instance instanceof HopeAPIError).toBe(true);
    }
  });
});

describe('APIConnectionError / APITimeoutError', () => {
  it('is constructible without an HTTP response and carries a cause', () => {
    const cause = new Error('ECONNREFUSED');
    const err = new APIConnectionError({ cause });
    expect(err.cause).toBe(cause);
    expect(err.status).toBe(0);
  });

  it('APITimeoutError is a kind of APIConnectionError', () => {
    const err = new APITimeoutError({});
    expect(err).toBeInstanceOf(APIConnectionError);
    expect(err.message.toLowerCase()).toContain('timed out');
  });
});
