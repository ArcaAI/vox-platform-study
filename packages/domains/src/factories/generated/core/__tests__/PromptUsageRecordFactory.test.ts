/**
 * PromptUsageRecordFactory Unit Tests
 *
 * Tests for the PromptUsageRecordFactory that creates PromptUsageRecord entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptUsageRecordFactory } from '../PromptUsageRecordFactory';

// TASK-305 A.6: tenantId is now required at the factory layer.
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('PromptUsageRecordFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: TEST_TENANT_ID });
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set default values for optional fields', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: TEST_TENANT_ID });
    expect(entity.promptTemplateId).toBeNull();
    expect(entity.promptVersionNumber).toBeNull();
    expect(entity.consultationId).toBeNull();
    expect(entity.doctorId).toBeNull();
    expect(entity.departmentId).toBeNull();
  });

  it('should not overwrite provided values', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({
      tenantId: TEST_TENANT_ID,
      promptTemplateId: 'template-123',
      promptVersionNumber: 2,
      consultationId: 'consult-123',
      doctorId: 'doctor-123',
      departmentId: 'dept-123',
    });
    expect(entity.promptTemplateId).toBe('template-123');
    expect(entity.promptVersionNumber).toBe(2);
    expect(entity.consultationId).toBe('consult-123');
    expect(entity.doctorId).toBe('doctor-123');
    expect(entity.departmentId).toBe('dept-123');
  });

  it('should set timestamps', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: TEST_TENANT_ID });
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('should set tenantId when provided', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: 'tenant-123' });
    expect(entity.tenantId).toBe('tenant-123');
  });

  it('should default createdBy and updatedBy to null', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: TEST_TENANT_ID });
    expect(entity.createdBy).toBeNull();
    expect(entity.updatedBy).toBeNull();
  });

  it('should create entity that passes validation', () => {
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({ tenantId: TEST_TENANT_ID });
    expect(() => entity.validate()).not.toThrow();
  });

  it('should use provided createdAt and updatedAt when supplied', () => {
    const customDate = new Date('2025-01-15T00:00:00.000Z');
    const entity = PromptUsageRecordFactory.CreatePromptUsageRecord({
      tenantId: TEST_TENANT_ID,
      createdAt: customDate,
      updatedAt: customDate,
    });
    expect(entity.createdAt).toBe(customDate);
    expect(entity.updatedAt).toBe(customDate);
  });
});
