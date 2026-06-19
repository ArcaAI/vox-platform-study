// TASK-369 Phase 3C — unit tests for the shared multi-field backfill engine
// (scripts/_phi-encryption-backfill.shared.ts). The runBackfill loop is
// integration-only (needs live Vault + Postgres); here we lock down argument
// parsing, the invocation guard, and the pure encrypt-data builder.
import { describe, it, expect, vi } from 'vitest';
import { buildEncryptedData, parseArgs, validateInvocation, type EncryptFn } from '../_phi-encryption-backfill.shared';

describe('parseArgs', () => {
  it('defaults to the dedicated PHI transit key (hope-phi)', () => {
    const out = parseArgs(['tsx', 'backfill-highlight-encryption.ts']);
    expect(out.transitKey).toBe('hope-phi');
    expect(out.transitMount).toBe('transit');
    expect(out.dryRun).toBe(false);
    expect(out.batchSize).toBe(200);
    expect(out.limit).toBeNull();
    expect(out.tenantId).toBeNull();
  });

  it('treats --dry-run as a boolean flag', () => {
    expect(parseArgs(['tsx', 'b.ts', '--dry-run']).dryRun).toBe(true);
  });

  it('parses --tenant, --batch-size and --limit', () => {
    const out = parseArgs(['tsx', 'b.ts', '--tenant=tenant-1', '--batch-size=50', '--limit=500']);
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
  const base = { dryRun: false, transitMount: 't', transitKey: 'k', batchSize: 200, limit: null, tenantId: null };

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

describe('buildEncryptedData', () => {
  const fakeEncrypt: EncryptFn = vi.fn(async (pt: string) => ({ ciphertext: `vault:v3:${pt.length}`, keyVersion: 3 }));

  it('encrypts every populated field and records the shared key version', async () => {
    const row = { id: 'h1', exact: 'severe pain', prefix: 'pt has ', suffix: ' today', note: 'follow up' };
    const fields = [
      { plaintext: 'exact', ciphertext: 'encryptedExact' },
      { plaintext: 'prefix', ciphertext: 'encryptedPrefix' },
      { plaintext: 'suffix', ciphertext: 'encryptedSuffix' },
      { plaintext: 'note', ciphertext: 'encryptedNote' },
    ];

    const { data, encryptedFieldCount } = await buildEncryptedData(row, fields, fakeEncrypt);

    expect(encryptedFieldCount).toBe(4);
    expect(data.encryptedExact).toBeInstanceOf(Buffer);
    expect(data.encryptedNote).toBeInstanceOf(Buffer);
    expect(data.keyVersion).toBe(3);
  });

  it('skips null / undefined / empty fields (partial rows are safe)', async () => {
    const row = { id: 'h2', exact: 'x', prefix: null, suffix: undefined, note: '' };
    const fields = [
      { plaintext: 'exact', ciphertext: 'encryptedExact' },
      { plaintext: 'prefix', ciphertext: 'encryptedPrefix' },
      { plaintext: 'suffix', ciphertext: 'encryptedSuffix' },
      { plaintext: 'note', ciphertext: 'encryptedNote' },
    ];

    const { data, encryptedFieldCount } = await buildEncryptedData(row, fields, fakeEncrypt);

    expect(encryptedFieldCount).toBe(1);
    expect(data).toHaveProperty('encryptedExact');
    expect(data).not.toHaveProperty('encryptedPrefix');
    expect(data).not.toHaveProperty('encryptedSuffix');
    expect(data).not.toHaveProperty('encryptedNote');
    expect(data.keyVersion).toBe(3);
  });

  it('produces NO key version (empty data) when there is nothing to encrypt', async () => {
    const row = { id: 'h3', exact: null, note: null };
    const fields = [
      { plaintext: 'exact', ciphertext: 'encryptedExact' },
      { plaintext: 'note', ciphertext: 'encryptedNote' },
    ];

    const { data, encryptedFieldCount } = await buildEncryptedData(row, fields, fakeEncrypt);

    expect(encryptedFieldCount).toBe(0);
    expect(data).not.toHaveProperty('keyVersion');
    expect(Object.keys(data)).toHaveLength(0);
  });

  it('stringifies JSON fields before encrypting (mirrors encryptJsonToCiphertext)', async () => {
    const encryptSpy = vi.fn(async (pt: string) => ({ ciphertext: `vault:v1:${pt}`, keyVersion: 1 }));
    const row = { id: 's1', citationsMap: { claim: ['span-1'] }, guardrailDecisions: null };
    const fields = [
      { plaintext: 'citationsMap', ciphertext: 'encryptedCitationsMap', json: true },
      { plaintext: 'guardrailDecisions', ciphertext: 'encryptedGuardrailDecisions', json: true },
    ];

    const { data, encryptedFieldCount } = await buildEncryptedData(row, fields, encryptSpy);

    expect(encryptedFieldCount).toBe(1);
    expect(encryptSpy).toHaveBeenCalledWith(JSON.stringify({ claim: ['span-1'] }));
    expect(data.encryptedCitationsMap).toBeInstanceOf(Buffer);
    expect(data).not.toHaveProperty('encryptedGuardrailDecisions');
  });
});
