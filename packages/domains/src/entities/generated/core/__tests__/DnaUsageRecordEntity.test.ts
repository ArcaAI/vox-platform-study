/**
 * DnaUsageRecordEntity Unit Tests
 *
 * Tests for the DnaUsageRecordEntity that handles DNA usage audit records.
 */

import { describe, it, expect } from 'vitest';
import { DnaUsageRecordEntity } from '../DnaUsageRecordEntity';
import type { IDnaUsageRecordEntity } from '../DnaUsageRecordEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IDnaUsageRecordEntity> = {}) =>
  new DnaUsageRecordEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    doctorId: 'doctor-1',
    dnaReportId: 'report-1',
    dnaVersionNumber: 1,
    consultationId: 'consult-1',
    departmentId: 'dept-1',
    createdBy: 'user-1',
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: null,
    version: 1,
    ...overrides,
  });

describe('DnaUsageRecordEntity', () => {
  it('should accept all fields in constructor', () => {
    const entity = createEntity();
    expect(entity.id).toBe('test-id');
    expect(entity.tenantId).toBe('test-tenant');
    expect(entity.doctorId).toBe('doctor-1');
    expect(entity.dnaReportId).toBe('report-1');
    expect(entity.dnaVersionNumber).toBe(1);
    expect(entity.consultationId).toBe('consult-1');
    expect(entity.departmentId).toBe('dept-1');
  });

  it('should track changes when fields are modified via setters', () => {
    const entity = createEntity();
    entity.consultationId = 'consult-2';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.consultationId).toBe('consult-2');
  });

  it('should have hasChanges false when no fields are modified', () => {
    const entity = createEntity();
    expect(entity.hasChanges).toBe(false);
  });

  it('should accept null values for all optional fields', () => {
    const entity = createEntity({
      doctorId: null,
      dnaReportId: null,
      dnaVersionNumber: null,
      consultationId: null,
      departmentId: null,
    });
    expect(entity.doctorId).toBeNull();
    expect(entity.dnaReportId).toBeNull();
    expect(entity.dnaVersionNumber).toBeNull();
    expect(entity.consultationId).toBeNull();
    expect(entity.departmentId).toBeNull();
  });

  it('should accept null for optional fields', () => {
    const entity = createEntity({ consultationId: null, departmentId: null });
    expect(entity.consultationId).toBeNull();
    expect(entity.departmentId).toBeNull();
  });
});
