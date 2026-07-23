// Field encryption for the
// remaining 9 clinical models (TranscriptionJob, GoldenCase, EvalRun,
// EvalScore, DnaWritingStyleReport, DnaWritingStyleVersion, KnowledgeChunk,
// Notification, PromptTemplate).
//
// Exercises each prototype-augmentation sibling (encrypt/decrypt round-trip +
// plaintext fallback) and the mandatory Bytes-safe mapper round-trip (the
// ciphertext Buffer must survive toPersistence -> toDomain without being
// destructured into a `{0: byte, …}` map). No real Prisma client.
import { describe, it, expect, vi } from 'vitest';
import 'reflect-metadata';

import { TranscriptionJobRepository } from '../generated/core/TranscriptionJobRepository';
import { GoldenCaseRepository } from '../generated/core/GoldenCaseRepository';
import { EvalRunRepository } from '../generated/core/EvalRunRepository';
import { EvalScoreRepository } from '../generated/core/EvalScoreRepository';
import { DnaWritingStyleReportRepository } from '../generated/core/DnaWritingStyleReportRepository';
import { DnaWritingStyleVersionRepository } from '../generated/core/DnaWritingStyleVersionRepository';
import { KnowledgeChunkRepository } from '../generated/core/KnowledgeChunkRepository';
import { NotificationRepository } from '../generated/core/NotificationRepository';
import { PromptTemplateRepository } from '../generated/core/PromptTemplateRepository';
import { SummaryMetaRepository } from '../generated/core/SummaryMetaRepository';

import { TranscriptionJobEntity } from '../../entities/generated/core/TranscriptionJobEntity';
import { GoldenCaseEntity } from '../../entities/generated/core/GoldenCaseEntity';
import { EvalRunEntity } from '../../entities/generated/core/EvalRunEntity';
import { EvalScoreEntity } from '../../entities/generated/core/EvalScoreEntity';
import { DnaWritingStyleReportEntity } from '../../entities/generated/core/DnaWritingStyleReportEntity';
import { DnaWritingStyleVersionEntity } from '../../entities/generated/core/DnaWritingStyleVersionEntity';
import { KnowledgeChunkEntity } from '../../entities/generated/core/KnowledgeChunkEntity';
import { NotificationEntity } from '../../entities/generated/core/NotificationEntity';
import { PromptTemplateEntity } from '../../entities/generated/core/PromptTemplateEntity';
import { SummaryMetaEntity } from '../../entities/generated/core/SummaryMetaEntity';
import { SummaryMetaEntityMapper } from '../../mappers/generated/core/SummaryMetaEntityMapper';

import { TranscriptionJobEntityMapper } from '../../mappers/generated/core/TranscriptionJobEntityMapper';
import { GoldenCaseEntityMapper } from '../../mappers/generated/core/GoldenCaseEntityMapper';
import { EvalScoreEntityMapper } from '../../mappers/generated/core/EvalScoreEntityMapper';
import { DnaWritingStyleReportEntityMapper } from '../../mappers/generated/core/DnaWritingStyleReportEntityMapper';
import { NotificationEntityMapper } from '../../mappers/generated/core/NotificationEntityMapper';
import { PromptTemplateEntityMapper } from '../../mappers/generated/core/PromptTemplateEntityMapper';

import type { SecretsServiceLike } from '../../common/field-encryption';

// Side-effect imports register the prototype methods.
import '../generated/core/TranscriptionJobRepository.encryption';
import '../generated/core/GoldenCaseRepository.encryption';
import '../generated/core/EvalRunRepository.encryption';
import '../generated/core/EvalScoreRepository.encryption';
import '../generated/core/DnaWritingStyleReportRepository.encryption';
import '../generated/core/DnaWritingStyleVersionRepository.encryption';
import '../generated/core/KnowledgeChunkRepository.encryption';
import '../generated/core/NotificationRepository.encryption';
import '../generated/core/PromptTemplateRepository.encryption';
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

describe('TranscriptionJobRepository encryption (Phase 3C)', () => {
  it('encrypts resultText (string) + resultMetadata (JSON), round-trips, keeps plaintext', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(TranscriptionJobRepository.prototype);
    const entity = new TranscriptionJobEntity({
      ...baseInit,
      resultText: 'patient reports cough',
      resultMetadata: { wordCount: 3 },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(secrets.encrypt).toHaveBeenCalledTimes(2);
    expect(entity.encryptedResultText).toBeInstanceOf(Buffer);
    expect(entity.encryptedResultMetadata).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);
    expect(entity.resultText).toBe('patient reports cough'); // transient plaintext kept in memory (column dropped in Phase 6)

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.resultText).toBe('patient reports cough');
    expect(out.resultMetadata).toEqual({ wordCount: 3 });
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new TranscriptionJobEntityMapper();
    const ct = Buffer.from('vault:v7:Y2lwaGVy', 'utf8');
    const entity = new TranscriptionJobEntity({ ...baseInit, encryptedResultText: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedResultText as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('GoldenCaseRepository encryption (Phase 3C)', () => {
  it('encrypts transcript + referenceNote (both string) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(GoldenCaseRepository.prototype);
    const entity = new GoldenCaseEntity({
      ...baseInit,
      transcript: 'doctor: how are you',
      referenceNote: 'SOAP note text',
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedTranscript).toBeInstanceOf(Buffer);
    expect(entity.encryptedReferenceNote).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.transcript).toBe('doctor: how are you');
    expect(out.referenceNote).toBe('SOAP note text');
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new GoldenCaseEntityMapper();
    const ct = Buffer.from('vault:v7:dHJhbnNjcmlwdA==', 'utf8');
    const entity = new GoldenCaseEntity({ ...baseInit, transcript: 'x', referenceNote: 'y', encryptedTranscript: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedTranscript as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('EvalRunRepository encryption (Phase 3C)', () => {
  it('encrypts notes (string), round-trips, returns null when ciphertext null (Phase 6)', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(EvalRunRepository.prototype);
    const entity = new EvalRunEntity({ ...baseInit, notes: 'reviewer comments' } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedNotes).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.notes).toBe('reviewer comments');

    // Phase 6 — no plaintext fallback: a fresh entity with only a transient
    // plaintext value and no ciphertext decrypts to null.
    const legacy = new EvalRunEntity({ ...baseInit, notes: 'legacy notes' } as any);
    const legacyOut = await repo.decryptFieldsFromEntity(legacy, secrets);
    expect(legacyOut.notes).toBeNull();
  });
});

describe('EvalScoreRepository encryption (Phase 3C)', () => {
  it('encrypts rationale (string) + details (JSON) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(EvalScoreRepository.prototype);
    const entity = new EvalScoreEntity({
      ...baseInit,
      rationale: 'scored low for completeness',
      details: { subscores: { completeness: 0.4 } },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(secrets.encrypt).toHaveBeenCalledTimes(2);
    expect(entity.encryptedRationale).toBeInstanceOf(Buffer);
    expect(entity.encryptedDetails).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.rationale).toBe('scored low for completeness');
    expect(out.details).toEqual({ subscores: { completeness: 0.4 } });
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new EvalScoreEntityMapper();
    const ct = Buffer.from('vault:v7:e30=', 'utf8');
    const entity = new EvalScoreEntity({ ...baseInit, encryptedDetails: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedDetails as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('DnaWritingStyleReportRepository encryption (Phase 3C)', () => {
  it('encrypts reportData (JSON) + styleText (string) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(DnaWritingStyleReportRepository.prototype);
    const entity = new DnaWritingStyleReportEntity({
      ...baseInit,
      reportData: { tone: 'concise' },
      styleText: 'prefers short sentences',
      // TASK-551 — structured redaction rules encrypted alongside the style text.
      redactionRules: { rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }] },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    // F-031 guard: the cipher MUST be invoked for the redaction rules (a writer
    // that skipped it would silently drop the doctor's rules to a plaintext-less row).
    expect(secrets.encrypt).toHaveBeenCalledTimes(3);
    expect(entity.encryptedReportData).toBeInstanceOf(Buffer);
    expect(entity.encryptedStyleText).toBeInstanceOf(Buffer);
    expect(entity.encryptedRedactionRules).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.reportData).toEqual({ tone: 'concise' });
    expect(out.styleText).toBe('prefers short sentences');
    expect(out.redactionRules).toEqual({
      rules: [{ id: 'r1', type: 'remove', match: 'literal', pattern: 'employer' }],
    });
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new DnaWritingStyleReportEntityMapper();
    const ct = Buffer.from('vault:v7:e30=', 'utf8');
    const entity = new DnaWritingStyleReportEntity({
      ...baseInit,
      encryptedReportData: ct,
      encryptedRedactionRules: ct,
    } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedReportData as Uint8Array).equals(ct)).toBe(true);
    expect(Buffer.from(back.encryptedRedactionRules as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('DnaWritingStyleVersionRepository encryption (Phase 3C)', () => {
  it('encrypts reportData (JSON) + styleText (string) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(DnaWritingStyleVersionRepository.prototype);
    const entity = new DnaWritingStyleVersionEntity({
      ...baseInit,
      reportData: { tone: 'formal' },
      styleText: 'uses passive voice',
      redactionRules: { rules: [{ id: 'r1', type: 'rewrite', match: 'literal', pattern: 'Mr X', replacement: 'the patient' }] },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(secrets.encrypt).toHaveBeenCalledTimes(3);
    expect(entity.encryptedReportData).toBeInstanceOf(Buffer);
    expect(entity.encryptedStyleText).toBeInstanceOf(Buffer);
    expect(entity.encryptedRedactionRules).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.reportData).toEqual({ tone: 'formal' });
    expect(out.styleText).toBe('uses passive voice');
    expect(out.redactionRules).toEqual({
      rules: [{ id: 'r1', type: 'rewrite', match: 'literal', pattern: 'Mr X', replacement: 'the patient' }],
    });
  });
});

describe('KnowledgeChunkRepository encryption (Phase 3C)', () => {
  it('encrypts text (string) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(KnowledgeChunkRepository.prototype);
    const entity = new KnowledgeChunkEntity({ ...baseInit, text: 'clinical guideline excerpt' } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedText).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.text).toBe('clinical guideline excerpt');
  });
});

describe('NotificationRepository encryption (Phase 3C)', () => {
  it('encrypts messageText/messageRichText (string) + messageContent (JSON) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(NotificationRepository.prototype);
    const entity = new NotificationEntity({
      ...baseInit,
      messageText: 'your summary is ready',
      messageRichText: '<b>your summary</b> is ready',
      messageContent: { cta: 'view' },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(secrets.encrypt).toHaveBeenCalledTimes(3);
    expect(entity.encryptedMessageText).toBeInstanceOf(Buffer);
    expect(entity.encryptedMessageRichText).toBeInstanceOf(Buffer);
    expect(entity.encryptedMessageContent).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.messageText).toBe('your summary is ready');
    expect(out.messageRichText).toBe('<b>your summary</b> is ready');
    expect(out.messageContent).toEqual({ cta: 'view' });
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new NotificationEntityMapper();
    const ct = Buffer.from('vault:v7:bXNn', 'utf8');
    const entity = new NotificationEntity({ ...baseInit, encryptedMessageText: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedMessageText as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('PromptTemplateRepository encryption (Phase 3C)', () => {
  it('encrypts lastTestOutput (string) and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(PromptTemplateRepository.prototype);
    const entity = new PromptTemplateEntity({ ...baseInit, lastTestOutput: 'generated SOAP note' } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    expect(entity.encryptedLastTestOutput).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.lastTestOutput).toBe('generated SOAP note');
  });

  it('mapper preserves the ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new PromptTemplateEntityMapper();
    const ct = Buffer.from('vault:v7:b3V0cHV0', 'utf8');
    const entity = new PromptTemplateEntity({ ...baseInit, encryptedLastTestOutput: ct } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedLastTestOutput as Uint8Array).equals(ct)).toBe(true);
  });
});

describe('SummaryMetaRepository encryption (Phase 3C) — TASK-551 redaction manifest', () => {
  const summaryInit = {
    ...baseInit,
    contextItemId: '02000000-0000-0000-0000-000000000001',
  };

  it('encrypts citationsMap + guardrailDecisions + redactionManifest and round-trips', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(SummaryMetaRepository.prototype);
    const entity = new SummaryMetaEntity({
      ...summaryInit,
      citationsMap: { claim1: ['seg-1'] },
      guardrailDecisions: { safety: 'PASS' },
      // TASK-551 audit manifest — spans + counts only, never removed PHI plaintext.
      redactionManifest: {
        applied: true,
        total_hits: 2,
        hits_by_rule: { 'r-employer': 2 },
      },
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    // F-031 guard: the cipher MUST be invoked for the redaction manifest (a writer
    // that skipped it would silently drop the audit trail to a plaintext-less row).
    expect(secrets.encrypt).toHaveBeenCalledTimes(3);
    expect(entity.encryptedCitationsMap).toBeInstanceOf(Buffer);
    expect(entity.encryptedGuardrailDecisions).toBeInstanceOf(Buffer);
    expect(entity.encryptedRedactionManifest).toBeInstanceOf(Buffer);
    expect(entity.keyVersion).toBe(7);

    const out = await repo.decryptFieldsFromEntity(entity, secrets);
    expect(out.redactionManifest).toEqual({
      applied: true,
      total_hits: 2,
      hits_by_rule: { 'r-employer': 2 },
    });
  });

  it('leaves encryptedRedactionManifest untouched when the transient plaintext is absent (finalize backfill no-clobber)', async () => {
    const secrets = fakeSecrets();
    const repo = repoOf(SummaryMetaRepository.prototype);
    // Mirrors the finalize path: a reloaded entity carries the previously-persisted
    // ciphertext but NOT the transient plaintext manifest; a re-encrypt on backfill
    // must not overwrite/clear it.
    const priorCiphertext = Buffer.from('vault:v7:existing', 'utf8');
    const entity = new SummaryMetaEntity({
      ...summaryInit,
      citationsMap: { claim1: ['seg-1'] },
      encryptedRedactionManifest: priorCiphertext,
    } as any);

    await repo.encryptFieldsIntoEntity(entity, secrets);
    // Only citationsMap was re-encrypted; the manifest cipher was NOT invoked again.
    expect(secrets.encrypt).toHaveBeenCalledTimes(1);
    expect(Buffer.from(entity.encryptedRedactionManifest as Uint8Array).equals(priorCiphertext)).toBe(true);
  });

  it('mapper preserves the redaction-manifest ciphertext Buffer (Bytes-safe)', () => {
    const mapper = new SummaryMetaEntityMapper();
    const ct = Buffer.from('vault:v7:bWFuaWZlc3Q=', 'utf8');
    const entity = new SummaryMetaEntity({
      ...summaryInit,
      encryptedRedactionManifest: ct,
      redactionApplied: true,
    } as any);
    const back = mapper.toDomainEntity(mapper.toPersistence(entity));
    expect(Buffer.from(back.encryptedRedactionManifest as Uint8Array).equals(ct)).toBe(true);
    expect(back.redactionApplied).toBe(true);
  });
});
