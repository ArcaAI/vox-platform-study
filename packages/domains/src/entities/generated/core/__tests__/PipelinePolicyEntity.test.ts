/**
 * PipelinePolicyEntity Unit Tests (TASK-356 Phase 5, Pillar B)
 *
 * Covers the scope/scopeId invariant of the polymorphic realtime-pipeline
 * policy table: a TENANT-default row must NOT carry a scopeId, while
 * DEPARTMENT / DOCTOR override rows MUST carry the department/user id they
 * target. The nullable toggle columns are pure storage (null => inherit).
 */

import { describe, it, expect } from 'vitest';
import { PipelinePolicyEntity, IPipelinePolicyEntity } from '../PipelinePolicyEntity';
import { PipelinePolicyScope, ResourceStatusType } from '../../../../enums';

function createTestEntity(overrides: Partial<IPipelinePolicyEntity> = {}): PipelinePolicyEntity {
  return new PipelinePolicyEntity({
    id: 'policy-test-id',
    tenantId: 'tenant-123',
    scope: PipelinePolicyScope.TENANT,
    scopeId: null,
    autoSummaryEnabled: null,
    autoNerEnabled: null,
    harnessEnabled: null,
    dnaStyleEnabled: null,
    createdBy: 'user-123',
    updatedBy: null,
    createdAt: new Date('2026-06-15T10:00:00Z'),
    updatedAt: new Date('2026-06-15T10:00:00Z'),
    resourceStatus: ResourceStatusType.ENABLED,
    metaData: null,
    version: 1,
    ...overrides,
  });
}

describe('PipelinePolicyEntity', () => {
  describe('constructor', () => {
    it('should initialize with provided toggle + scope values', () => {
      const entity = createTestEntity({
        scope: PipelinePolicyScope.DOCTOR,
        scopeId: 'doctor-9',
        autoSummaryEnabled: true,
        harnessEnabled: false,
        dnaStyleEnabled: true,
      });

      expect(entity.scope).toBe(PipelinePolicyScope.DOCTOR);
      expect(entity.scopeId).toBe('doctor-9');
      expect(entity.autoSummaryEnabled).toBe(true);
      expect(entity.harnessEnabled).toBe(false);
      expect(entity.dnaStyleEnabled).toBe(true);
      expect(entity.autoNerEnabled).toBeNull();
    });
  });

  describe('validate (scope/scopeId invariant)', () => {
    it('passes for a TENANT-default row with no scopeId', () => {
      const entity = createTestEntity({ scope: PipelinePolicyScope.TENANT, scopeId: null });
      expect(() => entity.validate()).not.toThrow();
    });

    it('throws when a TENANT-scope row carries a scopeId', () => {
      const entity = createTestEntity({ scope: PipelinePolicyScope.TENANT, scopeId: 'dept-1' });
      expect(() => entity.validate()).toThrow('TENANT scope must not set a scopeId');
    });

    it('passes for a DEPARTMENT override row with a scopeId', () => {
      const entity = createTestEntity({ scope: PipelinePolicyScope.DEPARTMENT, scopeId: 'dept-1' });
      expect(() => entity.validate()).not.toThrow();
    });

    it('throws when a DEPARTMENT override row is missing its scopeId', () => {
      const entity = createTestEntity({ scope: PipelinePolicyScope.DEPARTMENT, scopeId: null });
      expect(() => entity.validate()).toThrow('DEPARTMENT scope requires a scopeId');
    });

    it('throws when a DOCTOR override row is missing its scopeId', () => {
      const entity = createTestEntity({ scope: PipelinePolicyScope.DOCTOR, scopeId: '' });
      expect(() => entity.validate()).toThrow('DOCTOR scope requires a scopeId');
    });

    it('still enforces the tenant-context backstop from the base entity', () => {
      const entity = createTestEntity({ tenantId: '' });
      expect(() => entity.validate()).toThrow('missing tenant context');
    });
  });

  describe('toggle setters track changes', () => {
    it('records a harnessEnabled override on the change set', () => {
      const entity = createTestEntity();
      entity.harnessEnabled = true;
      expect(entity.hasChanges).toBe(true);
      expect(entity.changes).toHaveProperty('harnessEnabled', true);
    });
  });
});
