// TASK-369 Phase 3B — unit tests for the pure helpers in
// scripts/backfill-contextitem-content-encryption.ts.
//
// The main() loop is integration-only (needs live Vault + Postgres); here we
// lock down argument parsing + the invocation guard.
import { describe, it, expect } from 'vitest';
import { parseArgs, validateInvocation } from '../backfill-contextitem-content-encryption';

describe('parseArgs', () => {
  it('defaults to the dedicated PHI transit key (hope-phi)', () => {
    const out = parseArgs(['tsx', 'backfill-contextitem-content-encryption.ts']);
    expect(out.transitKey).toBe('hope-phi');
    expect(out.transitMount).toBe('transit');
    expect(out.dryRun).toBe(false);
    expect(out.batchSize).toBe(200);
    expect(out.limit).toBeNull();
    expect(out.tenantId).toBeNull();
    expect(out.type).toBeNull();
  });

  it('treats --dry-run as a boolean flag', () => {
    const out = parseArgs(['tsx', 'b.ts', '--dry-run']);
    expect(out.dryRun).toBe(true);
  });

  it('parses --type, --tenant, --batch-size and --limit', () => {
    const out = parseArgs(['tsx', 'b.ts', '--type=WORKNOTE', '--tenant=tenant-1', '--batch-size=50', '--limit=500']);
    expect(out.type).toBe('WORKNOTE');
    expect(out.tenantId).toBe('tenant-1');
    expect(out.batchSize).toBe(50);
    expect(out.limit).toBe(500);
  });

  it('falls back to a sane batch size for invalid input', () => {
    expect(parseArgs(['tsx', 'b.ts', '--batch-size=0']).batchSize).toBe(200);
    expect(parseArgs(['tsx', 'b.ts', '--batch-size=abc']).batchSize).toBe(200);
  });

  it('honors --transit-mount + --transit-key overrides', () => {
    const out = parseArgs(['tsx', 'b.ts', '--transit-mount=transit-prod', '--transit-key=hope-phi-v2']);
    expect(out.transitMount).toBe('transit-prod');
    expect(out.transitKey).toBe('hope-phi-v2');
  });
});

describe('validateInvocation', () => {
  const base = { dryRun: false, transitMount: 't', transitKey: 'k', batchSize: 200, limit: null, tenantId: null, type: null };

  it('returns ok when SECRETS_PROVIDER=vault', () => {
    expect(validateInvocation(base, { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv)).toEqual({ ok: true });
  });

  it('rejects with code 2 when SECRETS_PROVIDER is not vault', () => {
    const res = validateInvocation(base, { SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(2);
      expect(res.message).toMatch(/SECRETS_PROVIDER=vault/);
    }
  });

  it('rejects with code 2 when SECRETS_PROVIDER is missing entirely', () => {
    expect(validateInvocation(base, {} as NodeJS.ProcessEnv).ok).toBe(false);
  });
});
