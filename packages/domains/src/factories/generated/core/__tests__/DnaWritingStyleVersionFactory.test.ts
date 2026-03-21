/**
 * DnaWritingStyleVersionFactory Unit Tests
 *
 * Tests for the DnaWritingStyleVersionFactory that creates DnaWritingStyleVersion entities.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DnaWritingStyleVersionFactory } from '../DnaWritingStyleVersionFactory';

vi.mock('../../../../utils', () => ({
    generateId: vi.fn(() => 'generated-uuid-7'),
}));

describe('DnaWritingStyleVersionFactory', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should create entity with generated UUID7 id', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(entity.id).toBe('generated-uuid-7');
    });

    it('should set default values for optional fields', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(entity.dnaReportId).toBeNull();
        expect(entity.versionNumber).toBeNull();
        expect(entity.reportData).toBeNull();
        expect(entity.styleText).toBeNull();
        expect(entity.changeReason).toBeNull();
        expect(entity.changedBy).toBeNull();
    });

    it('should not overwrite provided values', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
            dnaReportId: 'report-123',
            versionNumber: 2,
            reportData: { key: 'value' },
            styleText: 'style text',
            changeReason: 'Updated',
            changedBy: 'user-123',
        });
        expect(entity.dnaReportId).toBe('report-123');
        expect(entity.versionNumber).toBe(2);
        expect(entity.reportData).toEqual({ key: 'value' });
        expect(entity.styleText).toBe('style text');
        expect(entity.changeReason).toBe('Updated');
        expect(entity.changedBy).toBe('user-123');
    });

    it('should set timestamps', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(entity.createdAt).toBeInstanceOf(Date);
        expect(entity.updatedAt).toBeInstanceOf(Date);
    });

    it('should default tenantId to standard UUID', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(entity.tenantId).toBe('50000000-0000-0000-0000-000000000000');
    });

    it('should set tenantId when provided', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({ tenantId: 'tenant-123' });
        expect(entity.tenantId).toBe('tenant-123');
    });

    it('should default createdBy and updatedBy to null', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(entity.createdBy).toBeNull();
        expect(entity.updatedBy).toBeNull();
    });

    it('should create entity that passes validation', () => {
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({});
        expect(() => entity.validate()).not.toThrow();
    });

    it('should use provided createdAt and updatedAt when supplied', () => {
        const customDate = new Date('2025-01-15T00:00:00.000Z');
        const entity = DnaWritingStyleVersionFactory.CreateDnaWritingStyleVersion({
            createdAt: customDate,
            updatedAt: customDate,
        });
        expect(entity.createdAt).toBe(customDate);
        expect(entity.updatedAt).toBe(customDate);
    });
});
