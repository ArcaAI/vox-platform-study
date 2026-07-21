// Unit tests for the rotation smoke script's argument parser. The script as a
// whole runs against a live staging Vault + Redis + HOPE API; only the pure
// parsing helper is unit-testable in isolation.
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../rotation-smoke';

describe('rotation-smoke parseArgs (Phase 6 Task 6.7)', () => {
  it('parses all four required flags + overlap', () => {
    const out = parseArgs([
      'tsx',
      'rotation-smoke.ts',
      '--base-url',
      'https://api.staging.arcaai.com',
      '--vault-addr',
      'https://vault.staging.arcaai.com',
      '--user',
      'smoke@arcaai.com',
      '--pass',
      'pw',
      '--overlap-sec',
      '120',
    ]);
    expect(out).toEqual({
      baseUrl: 'https://api.staging.arcaai.com',
      vaultAddr: 'https://vault.staging.arcaai.com',
      user: 'smoke@arcaai.com',
      pass: 'pw',
      overlapSec: 120,
    });
  });

  it('defaults overlap-sec to 60', () => {
    const out = parseArgs([
      'tsx',
      'rotation-smoke.ts',
      '--base-url',
      'a',
      '--vault-addr',
      'b',
      '--user',
      'u',
      '--pass',
      'p',
    ]);
    expect(out.overlapSec).toBe(60);
  });

  it('accepts --flag=value form', () => {
    const out = parseArgs([
      'tsx',
      'rotation-smoke.ts',
      '--base-url=https://api',
      '--vault-addr=https://vault',
      '--user=u',
      '--pass=p',
    ]);
    expect(out.baseUrl).toBe('https://api');
  });

  it('throws when a required flag is missing', () => {
    expect(() =>
      parseArgs(['tsx', 'rotation-smoke.ts', '--base-url', 'x']),
    ).toThrow(/required flags/i);
  });
});
