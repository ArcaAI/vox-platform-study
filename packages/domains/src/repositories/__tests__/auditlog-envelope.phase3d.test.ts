// AuditLog envelope-encryption
// repository helpers, exercised via the prototype-augmentation sibling. No real
// Prisma client is booted; the helpers are pure (local AES-GCM via an injected
// crypto handle + an already-resolved DEK — zero Vault round-trips).
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { AuditLogRepository } from '../generated/core/AuditLogRepository';
import type { AuditLogDek, EnvelopeCryptoLike } from '../generated/core/AuditLogRepository.encryption';
import { AuditLogFactory } from '../../factories';
import { AuditAction, ResourceType } from '../../enums';

// Side-effect import that registers the prototype methods.
import '../generated/core/AuditLogRepository.encryption';

/**
 * A reversible fake of the AES-256-GCM CryptoService: `gcm:<key>:<b64>`. Binding
 * the key into the blob lets decrypt assert the right DEK is used (a wrong key
 * throws, mirroring GCM auth-tag failure).
 */
function fakeCrypto(): EnvelopeCryptoLike {
  return {
    encrypt: vi.fn(async (data: string, key: string) => `gcm:${key}:${Buffer.from(data, 'utf8').toString('base64')}`),
    decrypt: vi.fn(async (enc: string, key: string) => {
      const [, k, b64] = enc.split(':');
      if (k !== key) throw new Error('GCM auth failed (wrong DEK)');
      return Buffer.from(b64, 'base64').toString('utf8');
    }),
  };
}

const dek: AuditLogDek = { dekKey: 'k'.repeat(32), dekWrapped: 'vault:v3:WRAPPED', dekKeyVersion: 3 };

const makeEntity = (data: unknown, previousData: unknown) =>
  AuditLogFactory.CreateAuditLog({
    tenantId: 'tenant-1',
    action: AuditAction.UPDATE,
    resourceType: ResourceType.User,
    data: data as never,
    previousData: previousData as never,
  });

describe('AuditLogRepository envelope encryption (Phase 3D)', () => {
  const repo = Object.create(AuditLogRepository.prototype) as AuditLogRepository;

  it('encryptEnvelopeIntoEntity writes ciphertext + wrapped-DEK metadata and retains plaintext', async () => {
    const crypto = fakeCrypto();
    const data = { name: 'Jane Doe', dob: '1990-01-01' };
    const previousData = { name: 'Jane D.' };
    const entity = makeEntity(data, previousData);

    await repo.encryptEnvelopeIntoEntity(entity, crypto, dek);

    expect(entity.encryptedData?.toString('utf8')).toBe(`gcm:${dek.dekKey}:${Buffer.from(JSON.stringify(data)).toString('base64')}`);
    expect(entity.encryptedPreviousData?.toString('utf8')).toBe(`gcm:${dek.dekKey}:${Buffer.from(JSON.stringify(previousData)).toString('base64')}`);
    expect(entity.dekWrapped).toBe('vault:v3:WRAPPED');
    expect(entity.dekKeyVersion).toBe(3);
    // Dual-read soak: plaintext columns are NOT cleared.
    expect(entity.data).toEqual(data);
    expect(entity.previousData).toEqual(previousData);
  });

  it('decryptEnvelopeFromEntity round-trips ciphertext back to the original payloads', async () => {
    const crypto = fakeCrypto();
    const data = { mrn: 'A123', notes: ['x', 'y'] };
    const previousData = {};
    const entity = makeEntity(data, previousData);
    await repo.encryptEnvelopeIntoEntity(entity, crypto, dek);

    const out = await repo.decryptEnvelopeFromEntity(entity, crypto, dek.dekKey);

    expect(out.data).toEqual(data);
    expect(out.previousData).toEqual(previousData);
    expect(crypto.decrypt).toHaveBeenCalledTimes(2);
  });

  it('decryptEnvelopeFromEntity falls back to plaintext for a legacy row (no ciphertext)', async () => {
    const crypto = fakeCrypto();
    const data = { legacy: true };
    const entity = makeEntity(data, {});

    const out = await repo.decryptEnvelopeFromEntity(entity, crypto, dek.dekKey);

    expect(out.data).toEqual(data);
    expect(out.previousData).toEqual({});
    expect(crypto.decrypt).not.toHaveBeenCalled();
  });

  it('encrypts a null data payload as decryptable JSON null (lossless round-trip)', async () => {
    const crypto = fakeCrypto();
    const entity = makeEntity(null, { was: 'set' });

    await repo.encryptEnvelopeIntoEntity(entity, crypto, dek);
    const out = await repo.decryptEnvelopeFromEntity(entity, crypto, dek.dekKey);

    expect(out.data).toBeNull();
    expect(out.previousData).toEqual({ was: 'set' });
  });
});
