/**
 * AuditLogEntity.validate() Unit Tests — TASK-261 (Tier 3)
 *
 * Locks in the real invariant implementation that replaces the previous
 * `throw new BusinessException('Method not implemented.')` stub.
 *
 * Invariants under test (derived from `audit.prisma`):
 *   - action: required, must be a member of `Enums.AuditAction`
 *   - resourceType: required, must be a member of `Enums.ResourceType`
 *   - responsibleUserId: optional; non-empty trimmed when present
 *   - responsibleIp: optional; <= 45 chars (IPv6 worst-case) when present
 *   - resourceId: optional; non-empty trimmed when present
 *   - eventType: optional; <= 100 chars when present
 *   - tenantId: nullable allowed (global-scope policy-engine pattern)
 *   - data / previousData / metadata: track-only Json (no structural validation
 *     per ticket policy — Conservative Defaults)
 */

import { describe, it, expect } from 'vitest';
import { AuditLogEntity, IAuditLogEntity } from '../generated/core/AuditLogEntity';
import { AuditAction, ResourceStatusType, ResourceType } from '../../enums';

function createValidInit(
  overrides: Partial<IAuditLogEntity> = {},
): IAuditLogEntity {
  return {
    id: 'audit-test-id',
    tenantId: '50000000-0000-0000-0000-000000000000',
    responsibleUserId: '60000000-0000-0000-0000-000000000000',
    responsibleIp: '127.0.0.1',
    resourceType: ResourceType.User,
    resourceId: 'user-1',
    resourceDatabase: 'db_main',
    correlationId: 'corr-1',
    causationId: 'cause-1',
    action: AuditAction.UPDATE,
    eventType: 'RESOURCE',
    success: true,
    data: { after: 'value' },
    previousData: { before: 'value' },
    metadata: null,
    Tenant: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as IAuditLogEntity;
}

describe('AuditLogEntity.validate()', () => {
  describe('valid entity', () => {
    it('should not throw for a fully valid entity', () => {
      const entity = new AuditLogEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow();
    });

    it('should not throw the legacy "Method not implemented." sentinel', () => {
      const entity = new AuditLogEntity(createValidInit());

      expect(() => entity.validate()).not.toThrow('Method not implemented.');
    });

    it('should accept tenantId = null (global-scope audit)', () => {
      // Some policy-engine flows write `{ tenantId: null }` for system-level
      // audit events. validate() must tolerate that case.
      const entity = new AuditLogEntity(createValidInit({ tenantId: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it.each(Object.values(AuditAction))(
      'should accept action %s',
      (action) => {
        const entity = new AuditLogEntity(createValidInit({ action }));

        expect(() => entity.validate()).not.toThrow();
      },
    );

    it('should not validate the structure of `data` / `previousData` / `metadata` (track-only)', () => {
      const entity = new AuditLogEntity(
        createValidInit({
          data: { anything: { deeply: { nested: [1, 2, 3] } } },
          previousData: 'a string',
          metadata: { foo: null },
        }),
      );

      expect(() => entity.validate()).not.toThrow();
    });
  });

  describe('action', () => {
    it('should throw when action is undefined', () => {
      const entity = new AuditLogEntity(
        createValidInit({ action: undefined as unknown as AuditAction }),
      );

      expect(() => entity.validate()).toThrow('AuditLog action is required');
    });

    it('should throw when action is not a member of AuditAction', () => {
      const entity = new AuditLogEntity(
        createValidInit({ action: 'NotAnAction' as unknown as AuditAction }),
      );

      expect(() => entity.validate()).toThrow('AuditLog action is invalid');
    });
  });

  describe('resourceType', () => {
    it('should throw when resourceType is undefined', () => {
      const entity = new AuditLogEntity(
        createValidInit({
          resourceType: undefined as unknown as ResourceType,
        }),
      );

      expect(() => entity.validate()).toThrow('AuditLog resourceType is required');
    });

    it('should throw when resourceType is not a member of ResourceType', () => {
      const entity = new AuditLogEntity(
        createValidInit({
          resourceType: 'NotAResourceType' as unknown as ResourceType,
        }),
      );

      expect(() => entity.validate()).toThrow('AuditLog resourceType is invalid');
    });
  });

  describe('responsibleUserId', () => {
    it('should accept null responsibleUserId', () => {
      const entity = new AuditLogEntity(
        createValidInit({ responsibleUserId: null }),
      );

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when responsibleUserId is whitespace only (present-but-blank)', () => {
      const entity = new AuditLogEntity(
        createValidInit({ responsibleUserId: '   ' }),
      );

      expect(() => entity.validate()).toThrow(
        'AuditLog responsibleUserId must not be blank',
      );
    });
  });

  describe('responsibleIp', () => {
    it('should accept null responsibleIp', () => {
      const entity = new AuditLogEntity(createValidInit({ responsibleIp: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when responsibleIp exceeds 45 characters', () => {
      const entity = new AuditLogEntity(
        createValidInit({ responsibleIp: 'x'.repeat(46) }),
      );

      expect(() => entity.validate()).toThrow(
        'AuditLog responsibleIp must not exceed 45 characters',
      );
    });
  });

  describe('resourceId', () => {
    it('should throw when resourceId is whitespace only (present-but-blank)', () => {
      const entity = new AuditLogEntity(createValidInit({ resourceId: '   ' }));

      expect(() => entity.validate()).toThrow(
        'AuditLog resourceId must not be blank',
      );
    });
  });

  describe('eventType', () => {
    it('should accept null eventType', () => {
      const entity = new AuditLogEntity(createValidInit({ eventType: null }));

      expect(() => entity.validate()).not.toThrow();
    });

    it('should throw when eventType exceeds 100 characters', () => {
      const entity = new AuditLogEntity(
        createValidInit({ eventType: 'x'.repeat(101) }),
      );

      expect(() => entity.validate()).toThrow(
        'AuditLog eventType must not exceed 100 characters',
      );
    });
  });
});
