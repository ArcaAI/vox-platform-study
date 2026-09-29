/**
 * The gateway request id — ONE value per request, `cls.getId()`.
 *
 * Source: the inbound `x-request-id` when it matches `^[A-Za-z0-9._-]{1,64}$`,
 * else a fresh uuidv7. Node lowercases incoming header names, so the lookup must
 * be lowercase — the previous `req.headers['X-Request-Id']` read could never
 * match, and every request got a fresh id regardless of what the caller sent.
 */
import { describe, expect, it, vi } from 'vitest';

import { CLS_MODULE_OPTIONS, REQUEST_STARTED_AT, resolveRequestId, setupRequestContext } from '../request-id';

const UUIDV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveRequestId (A1)', () => {
  it('honours a valid lowercase x-request-id', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': 'edge-1.abc_DEF-9' } })).toBe('edge-1.abc_DEF-9');
  });

  it('accepts exactly 64 characters', () => {
    const id = 'a'.repeat(64);
    expect(resolveRequestId({ headers: { 'x-request-id': id } })).toBe(id);
  });

  it('rejects a 65-character id and mints a uuidv7 instead', () => {
    const id = resolveRequestId({ headers: { 'x-request-id': 'a'.repeat(65) } });
    expect(id).toMatch(UUIDV7);
  });

  it('rejects an id carrying a newline (log-injection) and mints a uuidv7', () => {
    const id = resolveRequestId({ headers: { 'x-request-id': 'a\nb' } });
    expect(id).toMatch(UUIDV7);
    expect(id).not.toContain('\n');
  });

  it('rejects characters outside the safe set', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': 'a b' } })).toMatch(UUIDV7);
    expect(resolveRequestId({ headers: { 'x-request-id': 'a/b' } })).toMatch(UUIDV7);
    expect(resolveRequestId({ headers: { 'x-request-id': '' } })).toMatch(UUIDV7);
  });

  it('takes the first value of a repeated header', () => {
    expect(resolveRequestId({ headers: { 'x-request-id': ['first-id', 'second-id'] } })).toBe('first-id');
  });

  it('mints a uuidv7 when the header is absent', () => {
    expect(resolveRequestId({ headers: {} })).toMatch(UUIDV7);
    expect(resolveRequestId(undefined)).toMatch(UUIDV7);
  });

  it('is the idGenerator the CLS module is configured with', () => {
    expect(CLS_MODULE_OPTIONS.middleware?.idGenerator).toBe(resolveRequestId);
    expect(CLS_MODULE_OPTIONS.middleware?.generateId).toBe(true);
    expect(CLS_MODULE_OPTIONS.middleware?.mount).toBe(true);
    expect(CLS_MODULE_OPTIONS.middleware?.setup).toBe(setupRequestContext);
  });
});

describe('setupRequestContext', () => {
  it('aliases request.requestId, sets CLS correlationId and the X-Request-Id response header from cls.getId()', () => {
    const cls = { getId: vi.fn(() => 'rid-123'), set: vi.fn() };
    const req: Record<string | symbol, unknown> = { headers: {} };
    const res = { setHeader: vi.fn() };

    setupRequestContext(cls as never, req, res);

    expect(req.requestId).toBe('rid-123');
    expect(typeof req[REQUEST_STARTED_AT]).toBe('number');
    expect(cls.set).toHaveBeenCalledWith('correlationId', 'rid-123');
    expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', 'rid-123');
  });
});
