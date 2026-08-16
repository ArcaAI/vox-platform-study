import { describe, it, expect } from 'vitest';
import { encodeResumeToken, decodeResumeToken, RESUME_FROM_BEGINNING } from '../resume-token';

describe('resume token — opaque, transport-assigned, consumer-echoed (§3.6)', () => {
  it('round-trips a transport + cursor', () => {
    const token = encodeResumeToken('redis-stream', '1723800000000-0');
    expect(decodeResumeToken(token)).toEqual({ transport: 'redis-stream', cursor: '1723800000000-0' });
  });

  it('is base64url — contains no "+", "/" or "=" characters', () => {
    const token = encodeResumeToken('redis-stream', '1723800000000-0');
    expect(token).not.toMatch(/[+/=]/);
  });

  it('is opaque JSON of {v, t, c} under the hood', () => {
    const token = encodeResumeToken('redis-stream', 'abc');
    const decoded = decodeResumeToken(token);
    expect(decoded?.transport).toBe('redis-stream');
    expect(decoded?.cursor).toBe('abc');
  });

  it('returns null for a malformed token rather than throwing', () => {
    expect(decodeResumeToken('not-a-real-token!!!')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeResumeToken('')).toBeNull();
  });

  it('RESUME_FROM_BEGINNING is the well-known Redis "from the start" sentinel', () => {
    expect(RESUME_FROM_BEGINNING).toBe('0-0');
  });
});
