// TASK-369 (Data Encryption Initiative) Phase 3C — consultation-group field
// encryption (ContextItemVersion / Highlight / NamedEntity / SummaryMeta).
//
// Exercises the multi-field prototype-augmentation siblings (encrypt/decrypt
// round-trip + plaintext fallback) and the mandatory Bytes-safe mapper
// round-trip (ciphertext Buffer must survive toPersistence -> toDomain without
// being destructured into a `{0: byte, …}` map). No real Prisma client.
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';

import { ContextItemVersionRepository } from '../generated/core/ContextItemVersionRepository';
import { HighlightRepository } from '../generated/core/HighlightRepository';
import { NamedEntityRepository } from '../generated/core/NamedEntityRepository';
import { SummaryMetaRepository } from '../generated/core/SummaryMetaRepository';

import { ContextItemVersionEntity } from '../../entities/generated/core/ContextItemVersionEntity';
import { HighlightEntity } from '../../entities/generated/core/HighlightEntity';
import { NamedEntityEntity } from '../../entities/generated/core/NamedEntityEntity';
import { SummaryMetaEntity } from '../../entities/generated/core/SummaryMetaEntity';

import { ContextItemVersionEntityMapper } from '../../mappers/generated/core/ContextItemVersionEntityMapper';
import { HighlightEntityMapper } from '../../mappers/generated/core/HighlightEntityMapper';
import { NamedEntityEntityMapper } from '../../mappers/generated/core/NamedEntityEntityMapper';
import { SummaryMetaEntityMapper } from '../../mappers/generated/core/SummaryMetaEntityMapper';

import { HighlightTargetKind } from '../../enums';
import type { SecretsServiceLike } from '../../common/field-encryption';

// Side-effect imports register the prototype methods.
import '../generated/core/ContextItemVersionRepository.encryption';
import '../generated/core/HighlightRepository.encryption';
import '../generated/core/NamedEntityRepository.encryption';
import '../generated/core/SummaryMetaRepository.encryption';

const baseInit = {
  id: '01000000-0000-0000-0000-000000000001',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  createdBy: null,
  updatedBy: null,
  tenantId: 'tenant-1',
  Tenant: null,
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

describe('ContextItemVersionRepository encryption (Phase 3C)', () => {
  it('encrypts all populated fields, sets shared keyVersion, keeps plaintext', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(ContextItemVersionRepository.prototype);
    const entity = new ContextItemVersionEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      versionNumber: 2,
      content: 'chest pain',
      contentDiff: '+chest pain',
      changeSummary: 'added symptom',
      fieldChanges: { content: { old: '', new: 'chest pain' } },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);

    expect(secrets.encrypt).toHaveBeenCalledTimes(4);
    expect(entity.encryptedContent).toBeInstanceOf(Buffer);
    expect(entity.encryptedContentDiff).toBeInstanceOf(Buffer);
    expect(entity.encryptedChangeSummary).toBeInstanceOf(Buffer);
    expect(entity.encryptedFieldChanges).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);
    // dual-read soak: plaintext retained
    expect(entity.content).toBe('chest pain');
  });

  it('decrypts each field, falling back to plaintext when ciphertext is null', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(ContextItemVersionRepository.prototype);
    const entity = new ContextItemVersionEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      versionNumber: 2,
      content: 'legacy-plaintext',
      encryptedContentDiff: Buffer.from('vault:v7:ZGlmZg==', 'utf8'), // 'diff'
      fieldChanges: { a: 1 },
    } as any);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.content).toBe('legacy-plaintext'); // fallback (no ciphertext)
    expect(out.contentDiff).toBe('diff'); // decrypted
    expect(out.fieldChanges).toEqual({ a: 1 }); // fallback JSON
  });

  it('mapper preserves the ciphertext Buffer through toPersistence -> toDomain', () => {
    const mapper = new ContextItemVersionEntityMapper();
    const ct = Buffer.from('vault:v7:Y2lwaGVy', 'utf8');
    const entity = new ContextItemVersionEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      versionNumber: 1,
      encryptedContent: ct,
    } as any);

    const model = mapper.toPersistence(entity);
    expect(Buffer.isBuffer(model.encryptedContent) || model.encryptedContent instanceof Uint8Array).toBe(true);
    expect(Buffer.from(model.encryptedContent as Uint8Array).toString('utf8')).toBe('vault:v7:Y2lwaGVy');

    const back = mapper.toDomainEntity(model);
    expect(Buffer.from(back.encryptedContent as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('HighlightRepository encryption (Phase 3C)', () => {
  it('encrypts quote selectors + note and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(HighlightRepository.prototype);
    const entity = new HighlightEntity({
      ...baseInit,
      consultationId: 'consult-1',
      targetKind: HighlightTargetKind.TRANSCRIPT,
      exact: 'severe headache',
      prefix: 'reports ',
      suffix: ' since morning',
      note: 'follow up',
      startOffset: 10,
      endOffset: 25,
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedExact).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.exact).toBe('severe headache');
    expect(out.note).toBe('follow up');
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new HighlightEntityMapper();
    const ct = Buffer.from('vault:v7:ZXhhY3Q=', 'utf8');
    const entity = new HighlightEntity({
      ...baseInit,
      consultationId: 'consult-1',
      targetKind: HighlightTargetKind.TRANSCRIPT,
      exact: 'x',
      startOffset: 0,
      endOffset: 1,
      encryptedExact: ct,
    } as any);
    const model = mapper.toPersistence(entity);
    const back = mapper.toDomainEntity(model);
    expect(Buffer.from(back.encryptedExact as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('NamedEntityRepository encryption (Phase 3C)', () => {
  it('encrypts text/normalizedText/metadata, leaves ontology codes untouched', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(NamedEntityRepository.prototype);
    const entity = new NamedEntityEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      text: 'aspirin',
      className: 'MEDICATION',
      normalizedText: 'acetylsalicylic acid',
      metadata: { dose: '81mg' },
      rxnormCode: '1191',
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(secrets.encrypt).toHaveBeenCalledTimes(3);
    expect(entity.encryptedText).toBeInstanceOf(Buffer);
    expect(entity.encryptedMetadata).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);
    // ontology code is NOT encrypted (queryable identifier)
    expect(entity.rxnormCode).toBe('1191');

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.text).toBe('aspirin');
    expect(out.metadata).toEqual({ dose: '81mg' });
  });
});

describe('SummaryMetaRepository encryption (Phase 3C)', () => {
  it('encrypts JSONB provenance blobs and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(SummaryMetaRepository.prototype);
    const entity = new SummaryMetaEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      caseNoteIds: [],
      preSummaryIds: [],
      previousSummaryIds: [],
      citationsMap: { claim1: ['span-a'] },
      guardrailDecisions: { safety: 'PASS' },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedCitationsMap).toBeInstanceOf(Buffer);
    expect(entity.encryptedGuardrailDecisions).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.citationsMap).toEqual({ claim1: ['span-a'] });
    expect(out.guardrailDecisions).toEqual({ safety: 'PASS' });
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new SummaryMetaEntityMapper();
    const ct = Buffer.from('vault:v7:e30=', 'utf8');
    const entity = new SummaryMetaEntity({
      ...baseInit,
      contextItemId: 'ci-1',
      caseNoteIds: [],
      preSummaryIds: [],
      previousSummaryIds: [],
      encryptedCitationsMap: ct,
    } as any);
    const model = mapper.toPersistence(entity);
    const back = mapper.toDomainEntity(model);
    expect(Buffer.from(back.encryptedCitationsMap as Uint8Array).equals(ct)).toBe(true);
  });
});
