// TASK-721 R4 — `WorkflowTestFixture.input` is Vault-Transit encrypted, mirroring
// the GoldenCase treatment of `transcript`/`referenceNote`.
//
// Same three guarantees the GoldenCase pattern gives (see
// `phase3c-rest-encryption.phase3c.test.ts`), restated for the JSON payload:
//   1. encrypt/decrypt round-trip through the repository sibling;
//   2. what is PERSISTED is ciphertext bytes — the plaintext column is gone and
//      the mapper never destructures the Buffer;
//   3. the global decrypt-on-read registry knows this model, so every existing
//      reader (`fixture.input`) keeps working without a per-call-site change.
//
// No real Prisma client and no real Vault.
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';

import { WorkflowTestFixtureRepository } from '../generated/core/WorkflowTestFixtureRepository';
import { WorkflowTestFixtureEntity } from '../../entities/generated/core/WorkflowTestFixtureEntity';
import { WorkflowTestFixtureEntityMapper } from '../../mappers/generated/core/WorkflowTestFixtureEntityMapper';
import { PHI_CIPHERTEXT_FIELDS, PHI_MODEL_CIPHERTEXT, decryptPhiRows, setPhiReadSecrets } from '../../common/phi-read-decrypt';
import type { SecretsServiceLike } from '../../common/field-encryption';

// Side-effect import registers the prototype methods.
import '../generated/core/WorkflowTestFixtureRepository.encryption';

const baseInit = {
  id: '01000000-0000-0000-0000-0000000000f1',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
  tenantId: 'tenant-1',
  Tenant: null,
  name: 'Two-speaker follow-up visit',
};

/** Round-trippable fake Transit: base64-wraps the plaintext at version 7. */
function fakeSecrets(): SecretsServiceLike {
  return {
    encrypt: vi.fn(async (b: Buffer) => `vault:v7:${b.toString('base64')}`),
    decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

function repoOf<T>(proto: T): T {
  return Object.create(proto as object) as T;
}

const SYNTHETIC_INPUT = { transcript: 'Clinician: how have you been?', speakerCount: 2 };

describe('WorkflowTestFixtureRepository encryption (TASK-721 R4)', () => {
  it('encrypts the JSON input, round-trips it, and stamps the Transit key version', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(WorkflowTestFixtureRepository.prototype);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = new WorkflowTestFixtureEntity({ ...baseInit, input: SYNTHETIC_INPUT } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);

    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
    expect(entity.encryptedInput).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);
    // transient plaintext stays in memory for the rest of the request
    expect(entity.input).toEqual(SYNTHETIC_INPUT);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.input).toEqual(SYNTHETIC_INPUT);
  });

  it('no-ops when there is nothing to encrypt', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(WorkflowTestFixtureRepository.prototype);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = new WorkflowTestFixtureEntity({ ...baseInit, input: null } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);

    expect(secrets.encrypt).not.toHaveBeenCalled();
    expect(entity.encryptedInput ?? null).toBeNull();
  });

  it('persists CIPHERTEXT ONLY — the plaintext column is gone from the write payload', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(WorkflowTestFixtureRepository.prototype);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = new WorkflowTestFixtureEntity({ ...baseInit, input: SYNTHETIC_INPUT } as any);
    await repo.encryptFieldsIntoEntity(entity, secrets);

    const persisted = WorkflowTestFixtureEntityMapper.getInstance().toPersistence(entity);

    expect('input' in (persisted as unknown as Record<string, unknown>)).toBe(false);
    const bytes = Buffer.from(persisted.encryptedInput as Uint8Array);
    expect(bytes.toString('utf8')).toMatch(/^vault:v\d+:/);
    expect(bytes.toString('utf8')).not.toContain('Clinician');
    expect(persisted.keyVersion).toBe(7);
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe round trip)', () => {
    const mapper = WorkflowTestFixtureEntityMapper.getInstance();
    const ct = Buffer.from('vault:v7:Y2lwaGVy', 'utf8');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entity = new WorkflowTestFixtureEntity({ ...baseInit, encryptedInput: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedInput as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('WorkflowTestFixture decrypt-on-read wiring (TASK-721 R4)', () => {
  it('is registered in the global PHI ciphertext registry as a JSON field', () => {
    expect(PHI_CIPHERTEXT_FIELDS.encryptedInput).toEqual({ plaintext: 'input', json: true });
    expect(PHI_MODEL_CIPHERTEXT.workflowTestFixture).toEqual(['encryptedInput']);
  });

  it('repopulates the transient `input` from ciphertext on read', async () => {
    const secrets = fakeSecrets();
    setPhiReadSecrets(secrets);
    try {
      const row: Record<string, unknown> = {
        id: baseInit.id,
        name: baseInit.name,
        encryptedInput: new Uint8Array(Buffer.from(`vault:v7:${Buffer.from(JSON.stringify(SYNTHETIC_INPUT), 'utf8').toString('base64')}`, 'utf8')),
      };

      await decryptPhiRows(row, 'workflowTestFixture');

      expect(row.input).toEqual(SYNTHETIC_INPUT);
    } finally {
      setPhiReadSecrets(undefined);
    }
  });

  it('nulls the transient `input` when the ciphertext column is empty (no plaintext fallback)', async () => {
    const secrets = fakeSecrets();
    setPhiReadSecrets(secrets);
    try {
      const row: Record<string, unknown> = { id: baseInit.id, encryptedInput: null };
      await decryptPhiRows(row, 'workflowTestFixture');
      expect(row.input).toBeNull();
    } finally {
      setPhiReadSecrets(undefined);
    }
  });
});
