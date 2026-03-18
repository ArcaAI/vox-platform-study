/**
 * DnaWritingStyleVersionEntity Unit Tests
 *
 * Tests for the DnaWritingStyleVersionEntity that handles DNA writing style version snapshots.
 */

import { describe, it, expect } from 'vitest';
import { DnaWritingStyleVersionEntity } from '../DnaWritingStyleVersionEntity';
import type { IDnaWritingStyleVersionEntity } from '../DnaWritingStyleVersionEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IDnaWritingStyleVersionEntity> = {}) =>
    new DnaWritingStyleVersionEntity({
        id: 'test-id',
        tenantId: 'test-tenant',
        dnaReportId: 'report-1',
        versionNumber: 1,
        reportData: { style: 'formal' },
        styleText: 'Formal writing style',
        changeReason: 'Initial version',
        changedBy: 'user-1',
        DnaWritingStyleReport: null,
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

describe('DnaWritingStyleVersionEntity', () => {
    it('should accept all fields in constructor', () => {
        const entity = createEntity();
        expect(entity.id).toBe('test-id');
        expect(entity.tenantId).toBe('test-tenant');
        expect(entity.dnaReportId).toBe('report-1');
        expect(entity.versionNumber).toBe(1);
        expect(entity.reportData).toEqual({ style: 'formal' });
        expect(entity.styleText).toBe('Formal writing style');
        expect(entity.changeReason).toBe('Initial version');
        expect(entity.changedBy).toBe('user-1');
        expect(entity.DnaWritingStyleReport).toBeNull();
    });

    it('should track changes when fields are modified via setters', () => {
        const entity = createEntity();
        entity.styleText = 'Updated style text';
        expect(entity.hasChanges).toBe(true);
        expect(entity.changes.styleText).toBe('Updated style text');
    });

    it('should have hasChanges false when no fields are modified', () => {
        const entity = createEntity();
        expect(entity.hasChanges).toBe(false);
    });

    it('should accept null values for all optional fields', () => {
        const entity = createEntity({
            dnaReportId: null,
            versionNumber: null,
            reportData: null,
            styleText: null,
            changeReason: null,
            changedBy: null,
            DnaWritingStyleReport: null,
        });
        expect(entity.dnaReportId).toBeNull();
        expect(entity.versionNumber).toBeNull();
        expect(entity.reportData).toBeNull();
        expect(entity.styleText).toBeNull();
        expect(entity.changeReason).toBeNull();
        expect(entity.changedBy).toBeNull();
        expect(entity.DnaWritingStyleReport).toBeNull();
    });

    it('should accept null for optional fields', () => {
        const entity = createEntity({ changeReason: null, changedBy: null });
        expect(entity.changeReason).toBeNull();
        expect(entity.changedBy).toBeNull();
    });
});
