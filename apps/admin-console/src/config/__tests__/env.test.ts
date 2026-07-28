import { describe, expect, it } from 'vitest';
import { parseServerEnv } from '../env';

const VALID_SECRET = 'a-dev-only-secret-with-32-characters!';

describe('parseServerEnv', () => {
  it('rejects an ADMIN_SESSION_SECRET shorter than 32 characters', () => {
    expect(() => parseServerEnv({ ADMIN_SESSION_SECRET: 'too-short' })).toThrowError(/ADMIN_SESSION_SECRET/);
  });

  it('rejects a missing ADMIN_SESSION_SECRET', () => {
    expect(() => parseServerEnv({})).toThrowError(/ADMIN_SESSION_SECRET/);
  });

  it('defaults API_URL to the local gateway', () => {
    const env = parseServerEnv({ ADMIN_SESSION_SECRET: VALID_SECRET });
    expect(env.API_URL).toBe('http://localhost:8868');
  });

  it('accepts explicit values and rejects a malformed API_URL', () => {
    const env = parseServerEnv({ API_URL: 'https://gateway.example.com', ADMIN_SESSION_SECRET: VALID_SECRET });
    expect(env.API_URL).toBe('https://gateway.example.com');
    expect(() => parseServerEnv({ API_URL: 'not-a-url', ADMIN_SESSION_SECRET: VALID_SECRET })).toThrowError(/API_URL/);
  });
});
