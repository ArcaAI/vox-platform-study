/**
 * PromptUsageRecordEntity Unit Tests
 *
 * Tests for the PromptUsageRecordEntity that handles prompt usage audit records.
 */

import { describe, it, expect } from 'vitest';
import { PromptUsageRecordEntity } from '../PromptUsageRecordEntity';
import type { IPromptUsageRecordEntity } from '../PromptUsageRecordEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IPromptUsageRecordEntity> = {}) =>
  new PromptUsageRecordEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    promptTemplateId: 'template-1',
    promptVersionNumber: 1,
    consultationId: 'consult-1',
    doctorId: 'doctor-1',
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

describe('PromptUsageRecordEntity', () => {
  it('should accept all fields in constructor', () => {
    const entity = createEntity();
    expect(entity.id).toBe('test-id');
    expect(entity.tenantId).toBe('test-tenant');
    expect(entity.promptTemplateId).toBe('template-1');
    expect(entity.promptVersionNumber).toBe(1);
    expect(entity.consultationId).toBe('consult-1');
    expect(entity.doctorId).toBe('doctor-1');
    expect(entity.departmentId).toBe('dept-1');
  });

  it('should track changes when fields are modified via setters', () => {
    const entity = createEntity();
    entity.promptVersionNumber = 2;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.promptVersionNumber).toBe(2);
  });

  it('should have hasChanges false when no fields are modified', () => {
    const entity = createEntity();
    expect(entity.hasChanges).toBe(false);
  });

  it('should accept null values for all optional fields', () => {
    const entity = createEntity({
      promptTemplateId: null,
      promptVersionNumber: null,
      consultationId: null,
      doctorId: null,
      departmentId: null,
    });
    expect(entity.promptTemplateId).toBeNull();
    expect(entity.promptVersionNumber).toBeNull();
    expect(entity.consultationId).toBeNull();
    expect(entity.doctorId).toBeNull();
    expect(entity.departmentId).toBeNull();
  });

  it('should accept null for optional fields', () => {
    const entity = createEntity({ consultationId: null, departmentId: null });
    expect(entity.consultationId).toBeNull();
    expect(entity.departmentId).toBeNull();
  });
});
