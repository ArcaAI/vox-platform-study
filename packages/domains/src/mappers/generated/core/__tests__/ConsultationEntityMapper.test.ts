/**
 * ConsultationEntityMapper — `spokenLanguageMode` round trip (TASK-1004 D-3)
 *
 * `spokenLanguageMode` is the typed promotion of the legacy
 * `metadata.summaryLanguage` free-form key (`summary-language.ts`) — a closed
 * catalog id (`en`, `ml`, `ml-en`, ...) or `null` when no default was ever
 * declared. Locks:
 *  - the database row round-trips through the entity and back unchanged,
 *    including `null`;
 *  - `_version` is stripped from both write paths (Consultation lifecycle
 *    writes go through `updateWithVersion` — see the mapper's own header).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { ConsultationEntityMapper } from '../ConsultationEntityMapper';
import { Consultation } from '../../../../models/generated/core/ConsultationModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { ConsultationStatus } from '../../../../enums/generated/ConsultationStatus';

const sampleRow = (overrides: Partial<Consultation> = {}): Consultation =>
  new Consultation({
    id: 'c-1',
    tenantId: 't-1',
    patientId: 'patient-1',
    appointmentDate: new Date('2026-09-24T00:00:00.000Z'),
    doctorId: 'doctor-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: null,
    status: ConsultationStatus.OPEN,
    degradedReasons: [],
    spokenLanguageMode: 'ml-en',
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 2,
    metaData: null,
    ...overrides,
  } as Consultation);

describe('ConsultationEntityMapper — spokenLanguageMode', () => {
  const mapper = new ConsultationEntityMapper();

  it('toDomainEntity carries the declared spoken language mode', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.spokenLanguageMode).toBe('ml-en');
  });

  it('toDomainEntity carries `null` when no default was ever declared', () => {
    const entity = mapper.toDomainEntity(sampleRow({ spokenLanguageMode: null }));
    expect(entity.spokenLanguageMode).toBeNull();
  });

  it('round-trips through toPersistence without writing `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    const persisted = mapper.toPersistence(entity);
    expect(persisted.spokenLanguageMode).toBe('ml-en');
    expect(persisted).not.toHaveProperty('version');
  });

  it('a change to spokenLanguageMode alone survives toPersistenceChanges', () => {
    const entity = mapper.toDomainEntity(sampleRow({ spokenLanguageMode: null }));
    entity.spokenLanguageMode = 'en';
    const changes = mapper.toPersistenceChanges(entity);
    expect(changes).toMatchObject({ spokenLanguageMode: 'en' });
    expect(changes).not.toHaveProperty('version');
  });
});
