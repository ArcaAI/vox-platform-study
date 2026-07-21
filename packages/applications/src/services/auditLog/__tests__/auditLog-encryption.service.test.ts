/**
 * AuditLogEncryptionService — envelope encryption.
 *
 * Proves the applications-layer DEK lifecycle + envelope wiring against the REAL
 * domain sibling (AuditLogRepository.prototype.encrypt/decryptEnvelope...):
 *  - a Data Encryption Key is generated + Vault-wrapped ONCE and reused for all
 *    writes (zero per-row Vault round-trips on the hot path);
 *  - the DEK is a 32-byte AES-256 key (sizing contract for CryptoService);
 *  - data/previousData encrypt into the `encrypted*` columns while plaintext is
 *    retained (dual-read soak), and fetchById-style decrypt round-trips them;
 *  - a cold-cache instance unwraps a row's `dekWrapped` via Vault to read it;
 *  - legacy plaintext rows are a decrypt no-op;
 *  - best-effort: a missing/failing SecretsService leaves rows plaintext-only and
 *    never throws (and a Vault failure is backed off, not retried per row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { AuditLogRepository, AuditLogFactory, AuditAction, ResourceType, AuditLogEntity } from '@arcaai/domains';
import { AuditLogEncryptionService } from '../auditLog-encryption.service';
import type { ICryptoService } from '../../crypto/ICryptoService';

/** Reversible AES-GCM stand-in: `gcm:<key>:<b64>`; decrypt asserts the right DEK. */
function fakeCrypto(): ICryptoService {
  return {
    hash: vi.fn(),
    verify: vi.fn(),
    encrypt: vi.fn(async (data: string, key: string) => `gcm:${key}:${Buffer.from(data, 'utf8').toString('base64')}`),
    decrypt: vi.fn(async (enc: string, key: string) => {
      const [, k, b64] = enc.split(':');
      if (k !== key) throw new Error('GCM auth failed (wrong DEK)');
      return Buffer.from(b64, 'base64').toString('utf8');
    }),
  };
}

/** Reversible Vault Transit stand-in routed through hope-phi. */
function fakeSecrets() {
  return {
    getPhiTransitKeyName: () => 'hope-phi',
    encrypt: vi.fn(async (b: Buffer, _k?: string) => `vault:v1:${b.toString('base64')}`),
    decrypt: vi.fn(async (ct: string, _k?: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
  } as any;
}

const newRepo = () => Object.create(AuditLogRepository.prototype) as AuditLogRepository;

const makeEntity = (data: unknown, previousData: unknown): AuditLogEntity =>
  AuditLogFactory.CreateAuditLog({
    tenantId: 'tenant-1',
    action: AuditAction.UPDATE,
    resourceType: ResourceType.User,
    data: data as never,
    previousData: previousData as never,
  });

beforeEach(() => vi.clearAllMocks());

describe('AuditLogEncryptionService — write path', () => {
  it('generates + wraps the DEK once and reuses it across rows (no per-row Vault calls)', async () => {
    const crypto = fakeCrypto();
    const secrets = fakeSecrets();
    const svc = new AuditLogEncryptionService(crypto, secrets, newRepo());

    const e1 = makeEntity({ name: 'Jane' }, {});
    const e2 = makeEntity({ name: 'John' }, { name: 'J.' });
    await svc.encryptIntoEntity(e1);
    await svc.encryptIntoEntity(e2);

    // DEK wrapped exactly once (cached); two rows share the same wrapped reference.
    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
    expect(e1.dekWrapped).toBe(e2.dekWrapped);
    expect(e1.dekKeyVersion).toBe(1);
    // The wrapped material is a 32-byte AES-256 key.
    const wrappedBuf = secrets.encrypt.mock.calls[0][0] as Buffer;
    expect(wrappedBuf.length).toBe(32);
    expect(secrets.encrypt.mock.calls[0][1]).toBe('hope-phi');
  });

  it('writes ciphertext into encrypted* columns and retains plaintext (dual-read soak)', async () => {
    const svc = new AuditLogEncryptionService(fakeCrypto(), fakeSecrets(), newRepo());
    const data = { mrn: 'A123' };
    const e = makeEntity(data, {});

    await svc.encryptIntoEntity(e);

    expect(Buffer.isBuffer(e.encryptedData)).toBe(true);
    expect(Buffer.isBuffer(e.encryptedPreviousData)).toBe(true);
    expect(e.data).toEqual(data); // plaintext NOT cleared
  });
});

describe('AuditLogEncryptionService — read path', () => {
  it('decrypts encrypted* back into data/previousData reusing the cached DEK', async () => {
    const secrets = fakeSecrets();
    const svc = new AuditLogEncryptionService(fakeCrypto(), secrets, newRepo());
    const data = { mrn: 'X', notes: ['n1'] };
    const previousData = { mrn: 'old' };
    const e = makeEntity(data, previousData);
    await svc.encryptIntoEntity(e);

    // Simulate a fresh read where only ciphertext is trusted.
    e.data = {} as never;
    e.previousData = {} as never;
    await svc.decryptIntoEntity(e);

    expect(e.data).toEqual(data);
    expect(e.previousData).toEqual(previousData);
    expect(secrets.decrypt).not.toHaveBeenCalled(); // cached DEK, no unwrap
  });

  it('a cold-cache instance unwraps the row dekWrapped via Vault to decrypt', async () => {
    const writer = new AuditLogEncryptionService(fakeCrypto(), fakeSecrets(), newRepo());
    const data = { secret: 'value' };
    const e = makeEntity(data, {});
    await writer.encryptIntoEntity(e);
    e.data = {} as never; // wipe plaintext so only ciphertext can answer

    const readerSecrets = fakeSecrets();
    const reader = new AuditLogEncryptionService(fakeCrypto(), readerSecrets, newRepo());
    await reader.decryptIntoEntity(e);

    expect(e.data).toEqual(data);
    expect(readerSecrets.decrypt).toHaveBeenCalledTimes(1);
    expect(readerSecrets.decrypt.mock.calls[0][1]).toBe('hope-phi');
  });

  it('is a no-op for a legacy plaintext row (no ciphertext)', async () => {
    const secrets = fakeSecrets();
    const svc = new AuditLogEncryptionService(fakeCrypto(), secrets, newRepo());
    const legacy = makeEntity({ plain: true }, {});

    await svc.decryptIntoEntity(legacy);

    expect(legacy.data).toEqual({ plain: true });
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});

describe('AuditLogEncryptionService — best-effort fallback', () => {
  it('skips encryption (plaintext-only) when no SecretsService is wired', async () => {
    const svc = new AuditLogEncryptionService(fakeCrypto(), undefined, newRepo());
    const e = makeEntity({ a: 1 }, {});

    await svc.encryptIntoEntity(e);

    expect(e.encryptedData ?? null).toBeNull();
    expect(e.data).toEqual({ a: 1 });
  });

  it('does not throw and backs off DEK bootstrap when Vault is unavailable', async () => {
    const secrets = fakeSecrets();
    secrets.encrypt = vi.fn(async () => {
      throw new Error('vault-down');
    });
    const svc = new AuditLogEncryptionService(fakeCrypto(), secrets, newRepo());

    await expect(svc.encryptIntoEntity(makeEntity({ a: 1 }, {}))).resolves.toBeUndefined();
    await svc.encryptIntoEntity(makeEntity({ b: 2 }, {}));

    // Backoff: the failed wrap is not re-attempted per row during the outage.
    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
  });
});
