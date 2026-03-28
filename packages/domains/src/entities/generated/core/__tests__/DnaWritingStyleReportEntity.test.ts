/**
 * DnaWritingStyleReportEntity Unit Tests
 *
 * Tests for the DnaWritingStyleReportEntity that handles DNA writing style reports.
 */

import { describe, it, expect } from 'vitest';
import { DnaWritingStyleReportEntity } from '../DnaWritingStyleReportEntity';
import type { IDnaWritingStyleReportEntity } from '../DnaWritingStyleReportEntity';
import { ResourceStatusType } from '../../../../enums';

const createEntity = (overrides: Partial<IDnaWritingStyleReportEntity> = {}) =>
  new DnaWritingStyleReportEntity({
    id: 'test-id',
    tenantId: 'test-tenant',
    doctorId: 'doctor-1',
    departmentId: 'dept-1',
    reportData: { style: 'formal' },
    styleText: 'Formal writing style',
    isLatest: true,
    currentVersionNumber: 1,
    Doctor: null,
    Department: null,
    Versions: null,
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

describe('DnaWritingStyleReportEntity', () => {
  it('should accept all fields in constructor', () => {
    const entity = createEntity();
    expect(entity.id).toBe('test-id');
    expect(entity.tenantId).toBe('test-tenant');
    expect(entity.doctorId).toBe('doctor-1');
    expect(entity.departmentId).toBe('dept-1');
    expect(entity.reportData).toEqual({ style: 'formal' });
    expect(entity.styleText).toBe('Formal writing style');
    expect(entity.isLatest).toBe(true);
    expect(entity.currentVersionNumber).toBe(1);
    expect(entity.Doctor).toBeNull();
    expect(entity.Department).toBeNull();
    expect(entity.Versions).toBeNull();
  });

  it('should track changes when fields are modified via setters', () => {
    const entity = createEntity();
    entity.styleText = 'New style text';
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.styleText).toBe('New style text');
  });

  it('markAsLatest should set isLatest to true', () => {
    const entity = createEntity({ isLatest: false });
    entity.markAsLatest();
    expect(entity.isLatest).toBe(true);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.isLatest).toBe(true);
  });

  it('unmarkAsLatest should set isLatest to false', () => {
    const entity = createEntity({ isLatest: true });
    entity.unmarkAsLatest();
    expect(entity.isLatest).toBe(false);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.isLatest).toBe(false);
  });

  it('incrementVersion should increment currentVersionNumber by 1', () => {
    const entity = createEntity({ currentVersionNumber: 3 });
    entity.incrementVersion();
    expect(entity.currentVersionNumber).toBe(4);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes.currentVersionNumber).toBe(4);
  });

  it('should have hasChanges false when no fields are modified', () => {
    const entity = createEntity();
    expect(entity.hasChanges).toBe(false);
  });

  it('should accept null values for all optional fields', () => {
    const entity = createEntity({
      doctorId: null,
      departmentId: null,
      reportData: null,
      styleText: null,
      isLatest: null,
      currentVersionNumber: null,
      Doctor: null,
      Department: null,
      Versions: null,
    });
    expect(entity.doctorId).toBeNull();
    expect(entity.departmentId).toBeNull();
    expect(entity.reportData).toBeNull();
    expect(entity.styleText).toBeNull();
    expect(entity.isLatest).toBeNull();
    expect(entity.currentVersionNumber).toBeNull();
    expect(entity.Doctor).toBeNull();
    expect(entity.Department).toBeNull();
    expect(entity.Versions).toBeNull();
  });

  it('markAsLatest when isLatest is already true should remain idempotent', () => {
    const entity = createEntity({ isLatest: true });
    entity.markAsLatest();
    expect(entity.isLatest).toBe(true);
    // setProperty only tracks when value changes; no change so hasChanges stays false
    expect(entity.hasChanges).toBe(false);
  });

  it('unmarkAsLatest when isLatest is already false should remain idempotent', () => {
    const entity = createEntity({ isLatest: false });
    entity.unmarkAsLatest();
    expect(entity.isLatest).toBe(false);
    // setProperty only tracks when value changes; no change so hasChanges stays false
    expect(entity.hasChanges).toBe(false);
  });

  it('incrementVersion should handle null currentVersionNumber', () => {
    const entity = createEntity({ currentVersionNumber: null });
    entity.incrementVersion();
    expect(entity.currentVersionNumber).toBe(1);
  });
});
