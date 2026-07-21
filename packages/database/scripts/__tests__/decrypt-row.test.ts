// Unit tests for the READ-ONLY decrypt CLI
// (scripts/decrypt-row.ts). The Vault + Prisma round-trips are integration-only;
// here we lock down argument parsing, invocation validation, the model registry
// resolver, and the PURE decrypt helpers (per-field + AuditLog DEK-envelope)
// with injected fakes — NO live Vault / Postgres.
import { describe, it, expect, vi } from 'vitest';
import * as crypto from 'crypto';
import {
  parseArgs,
  validateInvocation,
  resolveModelKey,
  decryptField,
  decryptModelRow,
  decryptLocalPayload,
  decryptAuditLogRow,
  type DecryptFn,
  type FieldSpec,
} from '../decrypt-row';

/** Mirror of CryptoService.encrypt — produce a `gcm:v1:..` payload for round-trip tests. */
function gcmEncrypt(plaintext: string, key: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

describe('parseArgs', () => {
  it('parses space-separated flags (--model X --id Y) + boolean --json', () => {
    const out = parseArgs(['tsx', 'decrypt-row.ts', '--model', 'NamedEntity', '--id', 'row-1', '--json']);
    expect(out.model).toBe('NamedEntity');
    expect(out.id).toBe('row-1');
    expect(out.json).toBe(true);
    expect(out.field).toBeNull();
  });

  it('parses --k=v form and --field', () => {
    const out = parseArgs(['tsx', 'd.ts', '--model=AuditLog', '--id=a-1', '--field=data']);
    expect(out.model).toBe('AuditLog');
    expect(out.id).toBe('a-1');
    expect(out.field).toBe('data');
  });

  it('defaults to the dedicated PHI transit key (hope-phi) + transit mount', () => {
    const out = parseArgs(['tsx', 'd.ts']);
    expect(out.transitKey).toBe('hope-phi');
    expect(out.transitMount).toBe('transit');
    expect(out.json).toBe(false);
    expect(out.help).toBe(false);
  });

  it('honors --transit-mount + --transit-key overrides and --help', () => {
    const out = parseArgs(['tsx', 'd.ts', '--transit-mount', 'transit-prod', '--transit-key', 'hope-phi-v2', '--help']);
    expect(out.transitMount).toBe('transit-prod');
    expect(out.transitKey).toBe('hope-phi-v2');
    expect(out.help).toBe(true);
  });
});

describe('resolveModelKey', () => {
  it('resolves exact + case-insensitive model names', () => {
    expect(resolveModelKey('NamedEntity')).toBe('NamedEntity');
    expect(resolveModelKey('namedentity')).toBe('NamedEntity');
    expect(resolveModelKey('AuditLog')).toBe('AuditLog');
    expect(resolveModelKey('auditlog')).toBe('AuditLog');
  });

  it('returns null for an unknown model', () => {
    expect(resolveModelKey('Nope')).toBeNull();
  });
});

describe('validateInvocation', () => {
  const base = { help: false, json: false, model: 'NamedEntity', id: 'r1', field: null, transitMount: 't', transitKey: 'k' };

  it('returns ok with vault + model + id', () => {
    expect(validateInvocation(base, { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv)).toEqual({ ok: true });
  });

  it('rejects (code 2) when SECRETS_PROVIDER is not vault', () => {
    const res = validateInvocation(base, { SECRETS_PROVIDER: 'env' } as NodeJS.ProcessEnv);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(2);
      expect(res.message).toMatch(/SECRETS_PROVIDER=vault/);
    }
  });

  it('rejects (code 2) when --model / --id missing or unknown', () => {
    const env = { SECRETS_PROVIDER: 'vault' } as NodeJS.ProcessEnv;
    expect(validateInvocation({ ...base, model: null }, env).ok).toBe(false);
    expect(validateInvocation({ ...base, id: null }, env).ok).toBe(false);
    const unknown = validateInvocation({ ...base, model: 'Nope' }, env);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.code).toBe(2);
  });
});

describe('decryptField (per-field Transit)', () => {
  // Fake transit/decrypt: maps a `vault:..` ciphertext string → plaintext bytes.
  const PLAINTEXT: Record<string, string> = {
    'CT:text': 'Metformin',
    'CT:meta': JSON.stringify({ source: 'ner', spans: [1, 2] }),
  };
  const decrypt: DecryptFn = vi.fn(async (ct: string) => Buffer.from(PLAINTEXT[ct] ?? '', 'utf8'));

  it('decrypts a string field from its ciphertext column', async () => {
    const row = { encryptedText: Buffer.from('CT:text', 'utf8'), text: 'STALE-plaintext' };
    const spec: FieldSpec = { plaintext: 'text', ciphertext: 'encryptedText' };
    expect(await decryptField(row, spec, decrypt)).toEqual({ field: 'text', source: 'ciphertext', value: 'Metformin' });
  });

  it('JSON-parses a json field after decrypt', async () => {
    const row = { encryptedMetadata: Buffer.from('CT:meta', 'utf8') };
    const spec: FieldSpec = { plaintext: 'metadata', ciphertext: 'encryptedMetadata', json: true };
    const out = await decryptField(row, spec, decrypt);
    expect(out.source).toBe('ciphertext');
    expect(out.value).toEqual({ source: 'ner', spans: [1, 2] });
  });

  it('falls back to the plaintext column when ciphertext is null (dual-read soak)', async () => {
    const row = { encryptedText: null, text: 'legacy plaintext' };
    const spec: FieldSpec = { plaintext: 'text', ciphertext: 'encryptedText' };
    expect(await decryptField(row, spec, decrypt)).toEqual({ field: 'text', source: 'plaintext-fallback', value: 'legacy plaintext' });
  });

  it('reports absent when both columns are null', async () => {
    const row = { encryptedText: null, text: null };
    const spec: FieldSpec = { plaintext: 'text', ciphertext: 'encryptedText' };
    expect(await decryptField(row, spec, decrypt)).toEqual({ field: 'text', source: 'absent', value: null });
  });
});

describe('decryptModelRow', () => {
  const decrypt: DecryptFn = vi.fn(async () => Buffer.from('PLAIN', 'utf8'));
  const specs: FieldSpec[] = [
    { plaintext: 'exact', ciphertext: 'encryptedExact' },
    { plaintext: 'note', ciphertext: 'encryptedNote' },
  ];

  it('decrypts only the requested --field', async () => {
    const row = { encryptedExact: Buffer.from('x', 'utf8'), encryptedNote: Buffer.from('y', 'utf8') };
    const out = await decryptModelRow(row, specs, 'note', decrypt);
    expect(out).toHaveLength(1);
    expect(out[0].field).toBe('note');
  });

  it('throws on an unknown --field', async () => {
    await expect(decryptModelRow({}, specs, 'nope', decrypt)).rejects.toThrow(/Unknown --field/);
  });
});

describe('decryptLocalPayload (AuditLog AES-256-GCM)', () => {
  const key = 'abcdefghijklmnopqrstuvwxyz012345'; // 32 chars → 32-byte AES-256 key

  it('round-trips a gcm:v1: payload', () => {
    const enc = gcmEncrypt('hello PHI', key);
    expect(decryptLocalPayload(enc, key)).toBe('hello PHI');
  });

  it('throws on a malformed GCM payload', () => {
    expect(() => decryptLocalPayload('gcm:v1:deadbeef', key)).toThrow(/Invalid GCM ciphertext format/);
  });
});

describe('decryptAuditLogRow (DEK envelope)', () => {
  const dekKey = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ987654'; // 32 chars
  // Fake unwrap (transit/decrypt of dekWrapped) → the DEK key bytes.
  const unwrap: DecryptFn = vi.fn(async () => Buffer.from(dekKey, 'utf8'));

  it('unwraps the DEK once and decrypts both payloads', async () => {
    vi.mocked(unwrap).mockClear();
    const row = {
      dekWrapped: 'vault:v1:wrapped',
      encryptedData: Buffer.from(gcmEncrypt(JSON.stringify({ action: 'UPDATE' }), dekKey), 'utf8'),
      encryptedPreviousData: Buffer.from(gcmEncrypt(JSON.stringify({ action: 'CREATE' }), dekKey), 'utf8'),
      data: { stale: true },
      previousData: { stale: true },
    };

    const out = await decryptAuditLogRow(row, null, unwrap, decryptLocalPayload);

    expect(out).toEqual([
      { field: 'data', source: 'ciphertext', value: { action: 'UPDATE' } },
      { field: 'previousData', source: 'ciphertext', value: { action: 'CREATE' } },
    ]);
    // DEK is unwrapped ONCE and reused across both fields.
    expect(unwrap).toHaveBeenCalledTimes(1);
  });

  it('falls back to the plaintext JSONB column for legacy rows (no ciphertext)', async () => {
    const row = { dekWrapped: null, encryptedData: null, data: { legacy: 'plaintext' } };
    const out = await decryptAuditLogRow(row, 'data', unwrap, decryptLocalPayload);
    expect(out).toEqual([{ field: 'data', source: 'plaintext-fallback', value: { legacy: 'plaintext' } }]);
  });

  it('throws on an unknown AuditLog --field', async () => {
    await expect(decryptAuditLogRow({}, 'bogus', unwrap, decryptLocalPayload)).rejects.toThrow(/Unknown --field "bogus" for AuditLog/);
  });
});
