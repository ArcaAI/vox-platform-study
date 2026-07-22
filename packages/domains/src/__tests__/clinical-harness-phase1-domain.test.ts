/**
 * Domain-layer threading of the new clinical-harness fields.
 *
 * Proves the additive DB columns are reflected through the domain layer
 * (enum ⇄ entity ⇄ factory ⇄ data-model mapper) so the application/API layers
 * can read/write them:
 *
 *   • ConsultationStatus enum + Consultation.status (lifecycle state machine)
 *   • ContextItemType.SIGNED_NOTE + ContextItemVersion attestation fields
 *   • NamedEntity ontology codes + transcript-span provenance
 *   • SummaryMeta sensor scores + citation provenance
 */
import { describe, it, expect } from 'vitest';
import { ConsultationStatus, ContextItemType } from '../enums';
import { ConsultationFactory } from '../factories/generated/core/ConsultationFactory';
import { ContextItemVersionFactory } from '../factories/generated/core/ContextItemVersionFactory';
import { NamedEntityFactory } from '../factories/generated/core/NamedEntityFactory';
import { SummaryMetaFactory } from '../factories/generated/core/SummaryMetaFactory';
import { ConsultationEntityMapper } from '../mappers/generated/core/ConsultationEntityMapper';
import { ContextItemVersionEntityMapper } from '../mappers/generated/core/ContextItemVersionEntityMapper';
import { NamedEntityEntityMapper } from '../mappers/generated/core/NamedEntityEntityMapper';
import { SummaryMetaEntityMapper } from '../mappers/generated/core/SummaryMetaEntityMapper';
import { ContextItemVersion } from '../models/generated/core/ContextItemVersionModel';
import { NamedEntity } from '../models/generated/core/NamedEntityModel';

const TENANT_ID = '00000000-0000-0000-0000-000000000001';

describe('Phase 1 — enums', () => {
  it('ConsultationStatus has exactly the 7 lifecycle states', () => {
    // DRAFT_PENDING_SENSORS supports optimistic two-phase delivery.
    expect(new Set(Object.values(ConsultationStatus))).toEqual(
      new Set(['OPEN', 'RECORDING', 'DRAFT_PENDING_SENSORS', 'PENDING_REVIEW', 'SIGNED', 'CLOSED', 'REOPENED']),
    );
  });

  it('ContextItemType gained the SIGNED_NOTE member', () => {
    expect(ContextItemType.SIGNED_NOTE).toBe('SIGNED_NOTE');
  });
});

describe('Phase 1 — Consultation.status', () => {
  it('factory defaults status to OPEN and exposes isSigned=false', () => {
    const entity = ConsultationFactory.CreateConsultation({
      tenantId: TENANT_ID,
      patientId: 'p-1',
      appointmentDate: new Date('2026-06-06'),
      doctorId: 'd-1',
    });
    expect(entity.status).toBe(ConsultationStatus.OPEN);
    expect(entity.isSigned).toBe(false);
  });

  it('factory threads an explicit status and isSigned reflects SIGNED', () => {
    const entity = ConsultationFactory.CreateConsultation({
      tenantId: TENANT_ID,
      patientId: 'p-1',
      appointmentDate: new Date('2026-06-06'),
      doctorId: 'd-1',
      status: ConsultationStatus.SIGNED,
    });
    expect(entity.status).toBe(ConsultationStatus.SIGNED);
    expect(entity.isSigned).toBe(true);
  });

  it('mapper round-trips status (entity → model → entity)', () => {
    const mapper = new ConsultationEntityMapper();
    const entity = ConsultationFactory.CreateConsultation({
      tenantId: TENANT_ID,
      patientId: 'p-1',
      appointmentDate: new Date('2026-06-06'),
      doctorId: 'd-1',
      status: ConsultationStatus.PENDING_REVIEW,
    });
    const model = mapper.toPersistence(entity);
    expect(model.status).toBe(ConsultationStatus.PENDING_REVIEW);
    const back = mapper.toDomainEntity(model);
    expect(back.status).toBe(ConsultationStatus.PENDING_REVIEW);
  });
});

describe('Phase 1 — ContextItemVersion attestation', () => {
  const mapper = new ContextItemVersionEntityMapper();

  it('CreateSignedNoteVersion threads attestation fields onto the entity', () => {
    const entity = ContextItemVersionFactory.CreateSignedNoteVersion({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      versionNumber: 2,
      content: 'final signed note',
      attestedBy: 'clinician-1',
      attestationHash: 'a'.repeat(64),
      modelName: 'gpt-x',
      modelVersion: 'v2',
      sensorScores: { entityFaithfulness: 0.97 },
    });

    expect(entity.attestedBy).toBe('clinician-1');
    expect(entity.attestationHash).toBe('a'.repeat(64));
    expect(entity.modelName).toBe('gpt-x');
    expect(entity.modelVersion).toBe('v2');
    expect(entity.sensorScores).toEqual({ entityFaithfulness: 0.97 });
    expect(entity.attestedAt).toBeInstanceOf(Date);
    expect(entity.isAttested).toBe(true);
  });

  it('isAttested is false for a plain (unattested) version', () => {
    const entity = ContextItemVersionFactory.CreateVersion({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      versionNumber: 1,
    });
    expect(entity.isAttested).toBe(false);
  });

  it('toPersistence carries the attestation fields to the data model', () => {
    const attestedAt = new Date('2026-06-06T00:00:00.000Z');
    const entity = ContextItemVersionFactory.CreateSignedNoteVersion({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      versionNumber: 3,
      attestedBy: 'clinician-9',
      attestationHash: 'b'.repeat(64),
      attestedAt,
      sensorScores: { coverage: 0.8 },
    });
    const model = mapper.toPersistence(entity);
    expect(model.attestedBy).toBe('clinician-9');
    expect(model.attestationHash).toBe('b'.repeat(64));
    expect(model.sensorScores).toEqual({ coverage: 0.8 });
    // toObject() serializes Date → ISO string (Prisma accepts ISO for DateTime);
    // assert the instant is preserved regardless of representation.
    expect(model.attestedAt).toBeTruthy();
    expect(new Date(model.attestedAt as unknown as string).toISOString()).toBe(attestedAt.toISOString());
  });

  it('toDomainEntity hydrates the attestation fields from a row', () => {
    const attestedAt = new Date();
    const row = new ContextItemVersion({
      id: 'civ-1',
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      versionNumber: 4,
      content: null,
      contentDiff: null,
      changeReason: 'approved',
      changeSummary: null,
      changedBy: 'clinician-2',
      changeSource: 'attestation',
      fieldChanges: null,
      attestedAt,
      attestedBy: 'clinician-2',
      attestationHash: 'c'.repeat(64),
      modelName: 'm',
      modelVersion: 'v',
      sensorScores: { ragTriad: 0.9 },
      createdAt: new Date(),
    } as unknown as ContextItemVersion);

    const entity = mapper.toDomainEntity(row);
    expect(entity.attestedBy).toBe('clinician-2');
    expect(entity.attestationHash).toBe('c'.repeat(64));
    expect(entity.sensorScores).toEqual({ ragTriad: 0.9 });
    expect(entity.isAttested).toBe(true);
  });
});

describe('Phase 1 — NamedEntity ontology + transcript span', () => {
  const mapper = new NamedEntityEntityMapper();

  it('factory threads ontology codes + transcript span onto the entity', () => {
    const entity = NamedEntityFactory.CreateNamedEntity({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      text: 'aspirin',
      className: 'MEDICATION',
      umlsCui: 'C0004057',
      rxnormCode: '1191',
      snomedCode: '387458008',
      transcriptContextItemId: 'transcript-1',
      transcriptStartOffset: 10,
      transcriptEndOffset: 17,
    });

    expect(entity.umlsCui).toBe('C0004057');
    expect(entity.rxnormCode).toBe('1191');
    expect(entity.snomedCode).toBe('387458008');
    expect(entity.transcriptContextItemId).toBe('transcript-1');
    expect(entity.transcriptStartOffset).toBe(10);
    expect(entity.transcriptEndOffset).toBe(17);
    expect(entity.hasOntologyCodes).toBe(true);
    expect(entity.hasTranscriptSpan).toBe(true);
  });

  it('hasOntologyCodes/hasTranscriptSpan are false when absent', () => {
    const entity = NamedEntityFactory.CreateNamedEntity({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      text: 'fever',
      className: 'SYMPTOM',
    });
    expect(entity.hasOntologyCodes).toBe(false);
    expect(entity.hasTranscriptSpan).toBe(false);
  });

  it('mapper round-trips ontology + transcript span', () => {
    const entity = NamedEntityFactory.CreateNamedEntity({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      text: 'pneumonia',
      className: 'CONDITION',
      icdCode: 'J18.9',
      loincCode: '12345-6',
      transcriptContextItemId: 'transcript-9',
      transcriptStartOffset: 3,
      transcriptEndOffset: 12,
    });
    const model = mapper.toPersistence(entity);
    expect(model.icdCode).toBe('J18.9');
    expect(model.loincCode).toBe('12345-6');
    expect(model.transcriptContextItemId).toBe('transcript-9');
    expect(model.transcriptStartOffset).toBe(3);
    expect(model.transcriptEndOffset).toBe(12);

    const row = new NamedEntity({
      id: 'ne-1',
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      text: 'pneumonia',
      className: 'CONDITION',
      normalizedText: null,
      startOffset: null,
      endOffset: null,
      confidence: null,
      aiModelId: null,
      aiModelVersion: null,
      processingTimeMs: null,
      metadata: null,
      umlsCui: 'C0032285',
      snomedCode: null,
      rxnormCode: null,
      icdCode: 'J18.9',
      loincCode: null,
      transcriptContextItemId: 'transcript-9',
      transcriptStartOffset: 3,
      transcriptEndOffset: 12,
      createdAt: new Date(),
    } as unknown as NamedEntity);
    const back = mapper.toDomainEntity(row);
    expect(back.umlsCui).toBe('C0032285');
    expect(back.icdCode).toBe('J18.9');
    expect(back.transcriptStartOffset).toBe(3);
    expect(back.hasOntologyCodes).toBe(true);
    expect(back.hasTranscriptSpan).toBe(true);
  });
});

describe('Phase 1 — SummaryMeta sensor/citation provenance', () => {
  const mapper = new SummaryMetaEntityMapper();

  it('factory threads sensor scores + citation provenance', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      entityFaithfulnessScore: 0.93,
      coverageScore: 0.81,
      ragTriadScore: 0.77,
      citationsMap: { claim1: ['t1:0-10'] },
      guardrailDecisions: { pii: 'pass' },
      attestationRef: 'civ-1',
      modelName: 'gpt-x',
    });

    expect(entity.entityFaithfulnessScore).toBe(0.93);
    expect(entity.coverageScore).toBe(0.81);
    expect(entity.ragTriadScore).toBe(0.77);
    expect(entity.citationsMap).toEqual({ claim1: ['t1:0-10'] });
    expect(entity.guardrailDecisions).toEqual({ pii: 'pass' });
    expect(entity.attestationRef).toBe('civ-1');
    expect(entity.modelName).toBe('gpt-x');
  });

  it('toPersistence carries sensor scores but never the dropped citationsMap PHI', () => {
    const entity = SummaryMetaFactory.CreateSummaryMeta({
      tenantId: TENANT_ID,
      contextItemId: 'ctx-1',
      entityFaithfulnessScore: 0.5,
      citationsMap: { c: ['x'] },
    });
    const model = mapper.toPersistence(entity);
    expect(model.entityFaithfulnessScore).toBe(0.5);
    // CitationsMap/guardrailDecisions plaintext columns were
    // dropped; they survive only as transient fields persisted as ciphertext
    // (encryptedCitationsMap/encryptedGuardrailDecisions), never as plaintext.
    expect(model).not.toHaveProperty('citationsMap');
  });
});
