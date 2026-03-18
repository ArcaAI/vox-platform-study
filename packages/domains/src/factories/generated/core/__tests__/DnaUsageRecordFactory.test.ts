/**
 * DnaUsageRecordFactory Unit Tests
 *
 * Tests for the DnaUsageRecordFactory that creates DnaUsageRecord entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnaUsageRecordFactory } from '../DnaUsageRecordFactory';

vi.mock('../../../../utils', () => ({
    generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('DnaUsageRecordFactory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should create entity with generated UUID7 id', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(entity.id).toBe('generated-uuid-7');
    });

    it('should set default values for optional fields', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(entity.doctorId).toBeNull();
        expect(entity.dnaReportId).toBeNull();
        expect(entity.dnaVersionNumber).toBeNull();
        expect(entity.consultationId).toBeNull();
        expect(entity.departmentId).toBeNull();
    });

    it('should not overwrite provided values', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({
            doctorId: 'doctor-123',
            dnaReportId: 'report-123',
            dnaVersionNumber: 2,
            consultationId: 'consult-123',
            departmentId: 'dept-123',
        });
        expect(entity.doctorId).toBe('doctor-123');
        expect(entity.dnaReportId).toBe('report-123');
        expect(entity.dnaVersionNumber).toBe(2);
        expect(entity.consultationId).toBe('consult-123');
        expect(entity.departmentId).toBe('dept-123');
    });

    it('should set timestamps', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(entity.createdAt).toBeInstanceOf(Date);
        expect(entity.updatedAt).toBeInstanceOf(Date);
    });

    it('should default tenantId to standard UUID', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(entity.tenantId).toBe('50000000-0000-0000-0000-000000000000');
    });

    it('should set tenantId when provided', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({ tenantId: 'tenant-123' });
        expect(entity.tenantId).toBe('tenant-123');
    });

    it('should default createdBy and updatedBy to null', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(entity.createdBy).toBeNull();
        expect(entity.updatedBy).toBeNull();
    });

    it('should create entity that passes validation', () => {
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({});
        expect(() => entity.validate()).not.toThrow();
    });

    it('should use provided createdAt and updatedAt when supplied', () => {
        const customDate = new Date('2025-01-15T00:00:00.000Z');
        const entity = DnaUsageRecordFactory.CreateDnaUsageRecord({
            createdAt: customDate,
            updatedAt: customDate,
        });
        expect(entity.createdAt).toBe(customDate);
        expect(entity.updatedAt).toBe(customDate);
    });
});
