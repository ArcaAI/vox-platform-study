/**
 * ConsultationEntityMapper — `externalRef` round trip (TASK-1020 D-2)
 *
 * `externalRef` is the caller's own encounter id, promoted from the `metadata.externalRef` marker
 * to a nullable column so `open` can key on it and the database can enforce it (partial unique
 * index on `(tenantId, patientId, doctorId, externalRef) WHERE externalRef IS NOT NULL`).
 * Locks the round trip (including `null`) and that `_version` stays stripped from both write paths.
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
    appointmentDate: new Date('2026-09-29T00:00:00.000Z'),
    doctorId: 'doctor-1',
    departmentId: null,
    parentConsultationId: null,
    metadata: { externalRef: 'EVT-1' },
    externalRef: 'EVT-1',
    status: ConsultationStatus.OPEN,
    degradedReasons: [],
    spokenLanguageMode: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 3,
    metaData: null,
    ...overrides,
  } as Consultation);

describe('ConsultationEntityMapper — externalRef', () => {
  const mapper = new ConsultationEntityMapper();

  it('toDomainEntity carries the encounter id', () => {
    expect(mapper.toDomainEntity(sampleRow()).externalRef).toBe('EVT-1');
  });

  it('toDomainEntity carries null for a consultation opened without one', () => {
    expect(mapper.toDomainEntity(sampleRow({ externalRef: null })).externalRef).toBeNull();
  });

  it('writes the column on persistence and never writes `version`', () => {
    const persisted = mapper.toPersistence(mapper.toDomainEntity(sampleRow())) as any;
    expect(persisted.externalRef).toBe('EVT-1');
    expect(persisted).not.toHaveProperty('version');
  });
});
