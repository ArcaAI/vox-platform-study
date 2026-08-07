import util from 'node:util';

import { describe, expect, it } from 'vitest';

import { HopeAPIError, fromResponse } from '../errors';
import { RedactedValue, redact, redactHeaders } from '../redact';

const SECRET = 'sk-live-should-never-leak-abcdef123456';

describe('redactHeaders', () => {
  it('masks Authorization, X-API-Key, X-Service-Token, and Cookie', () => {
    const result = redactHeaders({
      Authorization: `Bearer ${SECRET}`,
      'X-API-Key': SECRET,
      'X-Service-Token': SECRET,
      Cookie: 'session=abc123',
    });
    expect(result.get('authorization')).toBe('[REDACTED]');
    expect(result.get('x-api-key')).toBe('[REDACTED]');
    expect(result.get('x-service-token')).toBe('[REDACTED]');
    expect(result.get('cookie')).toBe('[REDACTED]');
  });

  it('is case-insensitive on the header name', () => {
    const result = redactHeaders({ authorization: `Bearer ${SECRET}`, 'x-api-key': SECRET });
    expect(result.get('Authorization')).toBe('[REDACTED]');
    expect(result.get('X-Api-Key')).toBe('[REDACTED]');
  });

  it('leaves non-sensitive headers untouched', () => {
    const result = redactHeaders({ 'X-Request-Id': 'req-1', 'Content-Type': 'application/json' });
    expect(result.get('x-request-id')).toBe('req-1');
    expect(result.get('content-type')).toBe('application/json');
  });

  it('accepts a Headers instance as input, not only a plain object', () => {
    const input = new Headers({ Authorization: `Bearer ${SECRET}`, 'X-Request-Id': 'req-2' });
    const result = redactHeaders(input);
    expect(result.get('authorization')).toBe('[REDACTED]');
    expect(result.get('x-request-id')).toBe('req-2');
  });

  it('returns an empty Headers for null/undefined input', () => {
    expect([...redactHeaders(undefined).entries()]).toEqual([]);
    expect([...redactHeaders(null).entries()]).toEqual([]);
  });
});

describe('RedactedValue / redact — structural body redaction', () => {
  it('never exposes the wrapped value via toString/toJSON/util.inspect', () => {
    const wrapped = redact({ transcript: 'patient reports chest pain', apiKey: SECRET });
    expect(String(wrapped)).toBe('[REDACTED]');
    expect(wrapped.toString()).toBe('[REDACTED]');
    expect(JSON.stringify({ body: wrapped })).toBe('{"body":"[REDACTED]"}');
    expect(util.inspect(wrapped, { depth: null })).toBe('[REDACTED]');
    expect(util.inspect(wrapped, { depth: null })).not.toContain('chest pain');
  });

  it('still allows explicit, intentional access to the raw value via reveal()', () => {
    const wrapped = redact({ currentVersion: 5 });
    expect(wrapped.reveal()).toEqual({ currentVersion: 5 });
  });

  it('is an instance of RedactedValue', () => {
    expect(redact('x')).toBeInstanceOf(RedactedValue);
  });
});

describe('PHI/secret safety on HopeAPIError', () => {
  it('never leaks a redacted-sensitive header value through any string/serialization surface', () => {
    const headers = redactHeaders({
      Authorization: `Bearer ${SECRET}`,
      'X-API-Key': SECRET,
      'X-Request-Id': 'req-1',
    });
    const err = new HopeAPIError({ status: 500, message: 'boom', headers });

    const representations = [String(err), err.stack ?? '', err.message, JSON.stringify(err), util.inspect(err, { depth: null })];
    for (const repr of representations) {
      expect(repr).not.toContain(SECRET);
    }
    // non-sensitive header data survives, proving this isn't just "drop all headers"
    expect(err.headers?.get('x-request-id')).toBe('req-1');
  });

  it('still redacts even when raw (unredacted) sensitive headers are handed to fromResponse', () => {
    // Defense-in-depth: HopeAPIError itself redacts on the way in, so even a
    // caller who forgot to pre-redact cannot leak a secret through the error
    // — e.g. a debugging proxy that echoes the request Authorization header
    // back on the response.
    const rawHeaders = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${SECRET}` });
    const response = new Response(null, { status: 500, headers: rawHeaders });
    const err = fromResponse(response, { message: 'boom' });

    expect(util.inspect(err, { depth: null })).not.toContain(SECRET);
    expect(JSON.stringify(err)).not.toContain(SECRET);
  });
});
