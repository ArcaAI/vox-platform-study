// TASK-302 Phase 4 Task 4.7 (Stream B) — unit tests for the pure helpers
// in scripts/backfill-globalsetting-encryption.ts.
//
// The actual main() loop is integration-only (needs live Vault + Postgres)
// and is exercised via the bash smoke-test documented in the script header.
// Here we lock down argument parsing + the invocation guard.
import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  validateInvocation,
} from '../backfill-globalsetting-encryption';

describe('parseArgs', () => {
  it('parses --keys=A,B,C into a list', () => {
    const out = parseArgs([
      'tsx',
      'backfill-globalsetting-encryption.ts',
      '--keys=JWT_SECRET_KEY,OIDC_CLIENT_SECRET',
    ]);
    expect(out.keys).toEqual(['JWT_SECRET_KEY', 'OIDC_CLIENT_SECRET']);
    expect(out.dryRun).toBe(false);
    expect(out.transitMount).toBe('transit');
    expect(out.transitKey).toBe('hope-globalsetting');
  });

  it('treats --dry-run as a boolean flag (no value required)', () => {
    const out = parseArgs([
      'tsx',
      'backfill-globalsetting-encryption.ts',
      '--keys=K',
      '--dry-run',
    ]);
    expect(out.dryRun).toBe(true);
  });

  it('returns an empty key list when --keys is missing or empty', () => {
    expect(parseArgs(['tsx', 'b.ts']).keys).toEqual([]);
    expect(parseArgs(['tsx', 'b.ts', '--keys=']).keys).toEqual([]);
    expect(parseArgs(['tsx', 'b.ts', '--keys=,,,']).keys).toEqual([]);
  });

  it('honors --transit-mount + --transit-key overrides', () => {
    const out = parseArgs([
      'tsx',
      'b.ts',
      '--keys=K',
      '--transit-mount=transit-prod',
      '--transit-key=hope-secrets-v2',
    ]);
    expect(out.transitMount).toBe('transit-prod');
    expect(out.transitKey).toBe('hope-secrets-v2');
  });
});

describe('validateInvocation', () => {
  it('returns ok when keys are present and SECRETS_PROVIDER=vault', () => {
    expect(
      validateInvocation(
        { keys: ['JWT_SECRET_KEY'], dryRun: false, transitMount: 't', transitKey: 'k' },
        { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects with code 2 when --keys is empty', () => {
    const res = validateInvocation(
      { keys: [], dryRun: false, transitMount: 't', transitKey: 'k' },
      { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(2);
      expect(res.message).toMatch(/--keys/);
    }
  });

  it('rejects with code 2 when SECRETS_PROVIDER is not vault', () => {
    const res = validateInvocation(
      { keys: ['K'], dryRun: false, transitMount: 't', transitKey: 'k' },
      { SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(2);
      expect(res.message).toMatch(/SECRETS_PROVIDER=vault/);
    }
  });

  it('rejects with code 2 when SECRETS_PROVIDER is missing entirely', () => {
    const res = validateInvocation(
      { keys: ['K'], dryRun: false, transitMount: 't', transitKey: 'k' },
      {} as NodeJS.ProcessEnv,
    );
    expect(res.ok).toBe(false);
  });
});
