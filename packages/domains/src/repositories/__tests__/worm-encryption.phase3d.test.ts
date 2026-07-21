// Repository encryption helpers
// for the immutable WORM tables (HarnessAuditEvent / HarnessPolicyChange /
// PipelinePolicyChange), exercised via the prototype-augmentation siblings. No
// real Prisma client is booted; the helpers are pure (encrypt/decrypt only).
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';
import { HarnessAuditEventRepository } from '../generated/core/HarnessAuditEventRepository';
import { HarnessPolicyChangeRepository } from '../generated/core/HarnessPolicyChangeRepository';
import { PipelinePolicyChangeRepository } from '../generated/core/PipelinePolicyChangeRepository';
import { HarnessAuditEventFactory, HarnessPolicyChangeFactory, PipelinePolicyChangeFactory } from '../../factories';
import { HarnessAuditAction, PipelinePolicyScope } from '../../enums';
import type { SecretsServiceLike } from '../../common/field-encryption';

// Side-effect imports that register the prototype methods.
import '../generated/core/HarnessAuditEventRepository.encryption';
import '../generated/core/HarnessPolicyChangeRepository.encryption';
import '../generated/core/PipelinePolicyChangeRepository.encryption';

/** A reversible fake Vault Transit (`vault:v1:<base64>`), routed through hope-phi. */
function fakeSecrets(): SecretsServiceLike {
  return {
    encrypt: vi.fn(async (b: Buffer) => `vault:v1:${b.toString('base64')}`),
    decrypt: vi.fn(async (ct: string) => Buffer.from(ct.split(':').pop()!, 'base64')),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8').toString('base64');

describe('HarnessAuditEventRepository encryption (Phase 3D)', () => {
  const repo = Object.create(HarnessAuditEventRepository.prototype) as HarnessAuditEventRepository;

  it('encryptPayloads encrypts both fields under hope-phi and parses the key version', async () => {
    const secrets = fakeSecrets();
    const scores = { faithfulness: 0.9 };
    const cites = [{ id: 'c1' }];

    const out = await repo.encryptPayloads(secrets, scores, cites);

    expect(out.encryptedSensorScores?.toString('utf8')).toBe(`vault:v1:${b64(scores)}`);
    expect(out.encryptedCitations?.toString('utf8')).toBe(`vault:v1:${b64(cites)}`);
    expect(out.keyVersion).toBe(1);
    expect(secrets.encrypt).toHaveBeenCalledWith(expect.any(Buffer), 'hope-phi');
  });

  it('encryptPayloads yields null ciphertext for null/undefined fields', async () => {
    const secrets = fakeSecrets();
    const out = await repo.encryptPayloads(secrets, null, undefined);
    expect(out.encryptedSensorScores).toBeNull();
    expect(out.encryptedCitations).toBeNull();
    expect(out.keyVersion).toBeNull();
  });

  it('decryptPayloadsFromEntity round-trips the ciphertext back to the original JSON', async () => {
    const secrets = fakeSecrets();
    const scores = { faithfulness: 0.42, flags: ['x'] };
    const cites = [{ id: 'pmid:1' }];
    const enc = await repo.encryptPayloads(secrets, scores, cites);

    const entity = HarnessAuditEventFactory.CreateHarnessAuditEvent({
      tenantId: 'tenant-1',
      consultationId: 'consult-1',
      action: HarnessAuditAction.GENERATE,
      modelName: 'gpt',
      modelVersion: '1',
      sensorScores: scores,
      citations: cites,
      encryptedSensorScores: enc.encryptedSensorScores,
      encryptedCitations: enc.encryptedCitations,
      keyVersion: enc.keyVersion,
    });

    // The plaintext columns hold the sentinel; the real value lives in ciphertext.
    expect(entity.sensorScores).toEqual({ _encrypted: true });

    const dec = await repo.decryptPayloadsFromEntity(entity, secrets);
    expect(dec.sensorScores).toEqual(scores);
    expect(dec.citations).toEqual(cites);
  });

  it('decryptPayloadsFromEntity falls back to plaintext for a legacy row (no ciphertext)', async () => {
    const secrets = fakeSecrets();
    const scores = { faithfulness: 0.7 };
    const legacy = HarnessAuditEventFactory.CreateHarnessAuditEvent({
      tenantId: 'tenant-1',
      consultationId: 'consult-1',
      action: HarnessAuditAction.GENERATE,
      modelName: 'gpt',
      modelVersion: '1',
      sensorScores: scores,
      citations: [],
    });

    const dec = await repo.decryptPayloadsFromEntity(legacy, secrets);
    expect(dec.sensorScores).toEqual(scores);
    expect(secrets.decrypt).not.toHaveBeenCalled();
  });
});

describe('HarnessPolicyChangeRepository encryption (Phase 3D)', () => {
  const repo = Object.create(HarnessPolicyChangeRepository.prototype) as HarnessPolicyChangeRepository;

  it('round-trips before/after snapshots and leaves a null beforeJson null', async () => {
    const secrets = fakeSecrets();
    const after = { coverageThreshold: 0.5 };
    const enc = await repo.encryptPayloads(secrets, null, after);

    expect(enc.encryptedBeforeJson).toBeNull();
    expect(enc.encryptedAfterJson?.toString('utf8')).toBe(`vault:v1:${b64(after)}`);

    const entity = HarnessPolicyChangeFactory.CreateHarnessPolicyChange({
      tenantId: 'tenant-1',
      afterJson: after as never,
      encryptedBeforeJson: enc.encryptedBeforeJson,
      encryptedAfterJson: enc.encryptedAfterJson,
      keyVersion: enc.keyVersion,
    });
    expect(entity.afterJson).toEqual({ _encrypted: true });
    expect(entity.beforeJson ?? null).toBeNull();

    const dec = await repo.decryptPayloadsFromEntity(entity, secrets);
    expect(dec.beforeJson).toBeNull();
    expect(dec.afterJson).toEqual(after);
  });
});

describe('PipelinePolicyChangeRepository encryption (Phase 3D)', () => {
  const repo = Object.create(PipelinePolicyChangeRepository.prototype) as PipelinePolicyChangeRepository;

  it('round-trips before/after toggle snapshots', async () => {
    const secrets = fakeSecrets();
    const before = { harnessEnabled: false };
    const after = { harnessEnabled: true };
    const enc = await repo.encryptPayloads(secrets, before, after);

    const entity = PipelinePolicyChangeFactory.CreatePipelinePolicyChange({
      tenantId: 'tenant-1',
      scope: PipelinePolicyScope.TENANT,
      beforeJson: before as never,
      afterJson: after as never,
      encryptedBeforeJson: enc.encryptedBeforeJson,
      encryptedAfterJson: enc.encryptedAfterJson,
      keyVersion: enc.keyVersion,
    });
    expect(entity.beforeJson).toEqual({ _encrypted: true });
    expect(entity.afterJson).toEqual({ _encrypted: true });

    const dec = await repo.decryptPayloadsFromEntity(entity, secrets);
    expect(dec.beforeJson).toEqual(before);
    expect(dec.afterJson).toEqual(after);
  });
});
