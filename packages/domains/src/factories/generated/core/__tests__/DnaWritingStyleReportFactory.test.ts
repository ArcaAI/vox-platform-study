/**
 * DnaWritingStyleReportFactory Unit Tests
 *
 * Tests for the DnaWritingStyleReportFactory that creates DnaWritingStyleReport entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnaWritingStyleReportFactory } from '../DnaWritingStyleReportFactory';

// TASK-305 A.6: tenantId is now required at the factory layer.
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('DnaWritingStyleReportFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set default values for optional fields', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.doctorId).toBeNull();
    expect(entity.departmentId).toBeNull();
    expect(entity.reportData).toBeNull();
    expect(entity.styleText).toBeNull();
  });

  it('should default isLatest to true', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.isLatest).toBe(true);
  });

  it('should default currentVersionNumber to 1', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.currentVersionNumber).toBe(1);
  });

  it('should not overwrite provided values', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({
      tenantId: TEST_TENANT_ID,
      doctorId: 'doctor-123',
      departmentId: 'dept-123',
      reportData: { key: 'value' },
      styleText: 'style text',
      isLatest: false,
      currentVersionNumber: 3,
    });
    expect(entity.doctorId).toBe('doctor-123');
    expect(entity.departmentId).toBe('dept-123');
    expect(entity.reportData).toEqual({ key: 'value' });
    expect(entity.styleText).toBe('style text');
    expect(entity.isLatest).toBe(false);
    expect(entity.currentVersionNumber).toBe(3);
  });

  it('should set timestamps', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('should set tenantId when provided', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: 'tenant-123' });
    expect(entity.tenantId).toBe('tenant-123');
  });

  it('should default createdBy and updatedBy to null', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(entity.createdBy).toBeNull();
    expect(entity.updatedBy).toBeNull();
  });

  it('should create entity that passes validation', () => {
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({ tenantId: TEST_TENANT_ID });
    expect(() => entity.validate()).not.toThrow();
  });

  it('should use provided createdAt and updatedAt when supplied', () => {
    const customDate = new Date('2025-01-15T00:00:00.000Z');
    const entity = DnaWritingStyleReportFactory.CreateDnaWritingStyleReport({
      tenantId: TEST_TENANT_ID,
      createdAt: customDate,
      updatedAt: customDate,
    });
    expect(entity.createdAt).toBe(customDate);
    expect(entity.updatedAt).toBe(customDate);
  });
});
