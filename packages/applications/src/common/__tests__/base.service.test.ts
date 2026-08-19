/**
 * BaseService Unit Tests
 *
 * Tests for the abstract BaseService class that all application services extend.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseService } from '../base.service';
import { ResourceStatusType, SysEventType } from '@arcaai/domains';

// Mock ClsService
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

// Mock EventEmitter
const mockEventEmitter = {
  emit: vi.fn(),
};

// Mock BaseEntity for testing.
//
// Mirrors the real `BaseEntity` change-tracking contract closely enough to be
// meaningful: every setter routes through a `setProperty` that compares with
// `Object.is` and only records a change on a genuine value transition, and
// `hasChanges` reflects the tracked set. A mock with plain public fields would
// silently pass regardless of when `updatedBy` is stamped, which is exactly the
// behaviour under test here.
class MockEntity {
  private _changes: Record<string, unknown> = {};
  private _updatedBy: string | null = null;
  private _name: string | null = null;
  private _value: number | null = null;

  private setProperty(propertyName: string, value: unknown) {
    const internal = `_${propertyName}` as '_updatedBy' | '_name' | '_value';
    if (!Object.is((this as any)[internal], value)) {
      (this as any)[internal] = value;
      this._changes[propertyName] = value;
    }
  }

  get updatedBy(): string | null {
    return this._updatedBy;
  }

  set updatedBy(value: string | null) {
    this.setProperty('updatedBy', value);
  }

  get name(): string | null {
    return this._name;
  }

  set name(value: string | null) {
    this.setProperty('name', value);
  }

  get value(): number | null {
    return this._value;
  }

  set value(v: number | null) {
    this.setProperty('value', v);
  }

  get changes() {
    return this._changes;
  }

  get hasChanges() {
    return Object.keys(this._changes).length > 0;
  }

  setChange(key: string, value: unknown) {
    this._changes[key] = value;
  }
}

// Concrete implementation for testing
class TestService extends BaseService {
  constructor() {
    super(mockEventEmitter as unknown as EventEmitter2, mockClsService as any, 'TestResource' as any);
  }

  // Expose protected methods for testing
  public testBroadcastSysEvent(type: SysEventType, data: any) {
    return this.broadcastSysEvent(type, data);
  }

  public async testUpdateEntity(entity: any, changes: any) {
    return this.updateEntity(entity, changes);
  }
}

describe('BaseService', () => {
  let service: TestService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TestService();
  });

  describe('context getters', () => {
    describe('requestUser', () => {
      it('should return user from CLS context', () => {
        const mockUser = {
          id: 'user-123',
          firstName: 'John',
          lastName: 'Doe',
          email: 'john@example.com',
        };
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return mockUser;
          return null;
        });

        expect(service.requestUser).toEqual(mockUser);
      });

      it('should return null when no user in context', () => {
        mockClsService.get.mockReturnValue(null);

        expect(service.requestUser).toBeNull();
      });
    });

    describe('requestUserId', () => {
      it('should return user id from CLS context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { id: 'user-123' };
          return null;
        });

        expect(service.requestUserId).toBe('user-123');
      });

      it('should return null/undefined when no user', () => {
        mockClsService.get.mockReturnValue(null);

        // When user is null, accessing user?.id returns undefined
        expect(service.requestUserId).toBeFalsy();
      });
    });

    describe('requestUserName', () => {
      it('should return full name from user context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { firstName: 'John', lastName: 'Doe' };
          return null;
        });

        expect(service.requestUserName).toBe('John Doe');
      });
    });

    describe('requestUserEmail', () => {
      it('should return email from user context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'user') return { email: 'john@example.com' };
          return null;
        });

        expect(service.requestUserEmail).toBe('john@example.com');
      });
    });

    describe('tenantId', () => {
      it('should return tenant id from CLS context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantId') return 'tenant-123';
          return null;
        });

        expect(service.tenantId).toBe('tenant-123');
      });

      it('should return null when no tenant id', () => {
        mockClsService.get.mockReturnValue(null);

        expect(service.tenantId).toBeNull();
      });
    });

    describe('tenantCode', () => {
      it('should return tenant code from CLS context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'tenantCode') return 'TENANT_CODE';
          return null;
        });

        expect(service.tenantCode).toBe('TENANT_CODE');
      });
    });

    describe('correlationId', () => {
      it('should return correlation id from CLS context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'correlationId') return 'corr-123';
          return null;
        });

        expect(service.correlationId).toBe('corr-123');
      });
    });

    describe('requestIp', () => {
      it('should return request IP from CLS context', () => {
        mockClsService.get.mockImplementation((key: string) => {
          if (key === 'requestIp') return '192.168.1.1';
          return null;
        });

        expect(service.requestIp).toBe('192.168.1.1');
      });
    });
  });

  describe('broadcastSysEvent', () => {
    it('should emit event with correct data', () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'user':
            return { id: 'user-123' };
          case 'requestIp':
            return '192.168.1.1';
          case 'correlationId':
            return 'corr-123';
          case 'tenantId':
            return 'tenant-456';
          default:
            return null;
        }
      });

      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, {
        resourceId: 'resource-123',
        action: 'create',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'RESOURCE_CREATED',
        expect.objectContaining({
          resourceId: 'resource-123',
          action: 'create',
          responsibleEntityId: 'user-123',
          responsibleIp: '192.168.1.1',
          resourceType: 'TestResource',
          correlationId: 'corr-123',
          tenantId: 'tenant-456',
        }),
      );
    });

    it('should emit event even without user context', () => {
      mockClsService.get.mockReturnValue(null);

      service.testBroadcastSysEvent('RESOURCE_UPDATED' as SysEventType, {
        resourceId: 'resource-123',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalled();
    });
  });

  /*
   * `tenantId` is a security boundary, not a
   * debug/audit convenience. The merge order in `broadcastSysEvent` must
   * make the CLS-resolved tenantId WIN over any caller-supplied
   * `payload.tenantId` so an upstream caller cannot misattribute events
   * to a foreign tenant. Other CLS-context fields (`responsibleEntityId`,
   * `responsibleIp`, `correlationId`) remain overridable to keep the
   * background-process pattern (STT internal, cron jobs) working.
   */
  describe('broadcastSysEvent CLS wins on tenantId', () => {
    it('uses CLS tenantId even when payload supplies a different tenantId', () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-A';
        return null;
      });

      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, {
        tenantId: 'tenant-B',
        other: 'x',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'RESOURCE_CREATED',
        expect.objectContaining({
          tenantId: 'tenant-A',
          other: 'x',
        }),
      );
    });

    // The emitted envelope is a plain object, NOT a `SysEvent` instance, so the
    // constructor's `id = props.id || generateId()` never runs here. Without an
    // explicit id every event carried `id: undefined`, which collapsed the
    // webhook fan-out's BullMQ job id to `hook:<webhookId>:undefined` — BullMQ
    // deduplicated it, so each webhook fired once and then never again.
    it('stamps a unique envelope id on every event (webhook fan-out keys its job id off it)', () => {
      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, { other: 'x' });
      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, { other: 'y' });

      const [first, second] = mockEventEmitter.emit.mock.calls.map(([, payload]: [string, { id?: string }]) => payload.id);
      expect(typeof first).toBe('string');
      expect(first).toBeTruthy();
      expect(second).not.toBe(first);
    });

    // The type used to live ONLY in the emit channel name, so `event.type` was
    // undefined on the payload and the webhook body's `eventType` was dropped by
    // JSON.stringify — subscribers were told something happened, but not what.
    it('carries the event type on the envelope, not just as the emit channel', () => {
      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, { other: 'x' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('RESOURCE_CREATED', expect.objectContaining({ type: 'RESOURCE_CREATED' }));
    });

    it('lets an explicit caller-supplied envelope id win', () => {
      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, { id: 'caller-supplied-id' });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith('RESOURCE_CREATED', expect.objectContaining({ id: 'caller-supplied-id' }));
    });

    it('uses CLS tenantId when payload omits tenantId', () => {
      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'tenantId') return 'tenant-A';
        return null;
      });

      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, {
        other: 'x',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'RESOURCE_CREATED',
        expect.objectContaining({
          tenantId: 'tenant-A',
          other: 'x',
        }),
      );
    });

    // A SUPER_ADMIN authenticates with an empty CLS tenantId and
    // stays unscoped until they elevate to a working tenant (see
    // `resolve-active-tenant.ts`). Any mutation broadcast during that window
    // (e.g. a self-service UserSettings save while browsing the cross-tenant
    // audit-logs grid) previously stamped `tenantId: null`, which
    // `AuditLogProcessor`'s fail-closed guard rejects outright. Falls back to
    // the reserved SYSTEM tenant — the same convention already used by
    // `AuditLogService` for pre-CLS LOGIN/IMPERSONATION events
    // — so platform-level events attribute to SYSTEM instead of crashing the
    // queue. The anti-spoofing invariant is unchanged: the caller-supplied
    // `payload.tenantId` is still never used.
    it('falls back to the SYSTEM tenant when CLS is absent (does not silently accept payload tenantId)', () => {
      mockClsService.get.mockReturnValue(null);

      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, {
        tenantId: 'tenant-B',
        other: 'x',
      });

      const [, payload] = (mockEventEmitter.emit as ReturnType<typeof vi.fn>).mock.calls[0] as [string, Record<string, unknown>];
      expect(payload.tenantId).toBe('00000000-0000-0000-0000-000000000000');
      expect(payload.other).toBe('x');
    });

    it('still allows caller to override non-tenant CLS fields (background-process pattern)', () => {
      mockClsService.get.mockImplementation((key: string) => {
        switch (key) {
          case 'tenantId':
            return 'tenant-A';
          case 'user':
            return { id: 'cls-user-id' };
          case 'requestIp':
            return '10.0.0.1';
          case 'correlationId':
            return 'cls-corr';
          default:
            return null;
        }
      });

      service.testBroadcastSysEvent('RESOURCE_CREATED' as SysEventType, {
        tenantId: 'tenant-B',
        responsibleEntityId: 'payload-user-id',
        responsibleIp: '192.168.99.99',
        correlationId: 'payload-corr',
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'RESOURCE_CREATED',
        expect.objectContaining({
          tenantId: 'tenant-A',
          responsibleEntityId: 'payload-user-id',
          responsibleIp: '192.168.99.99',
          correlationId: 'payload-corr',
        }),
      );
    });
  });

  describe('updateEntity', () => {
    it('should apply changes to entity', async () => {
      const entity = new MockEntity();
      const changes = { name: 'New Name', value: 100 };

      mockClsService.get.mockImplementation((key: string) => {
        if (key === 'user') return { id: 'user-123' };
        return null;
      });

      await service.testUpdateEntity(entity, changes);

      expect(entity.updatedBy).toBe('user-123');
    });

    it('should return entity changes', async () => {
      const entity = new MockEntity();
      entity.setChange('name', 'Changed Name');
      const changes = { name: 'New Name' };

      mockClsService.get.mockReturnValue({ id: 'user-123' });

      const result = await service.testUpdateEntity(entity, changes);

      expect(result).toEqual(entity.changes);
    });

    it('should not set updatedBy when no user in context', async () => {
      const entity = new MockEntity();
      const changes = { name: 'New Name' };

      mockClsService.get.mockReturnValue(null);

      await service.testUpdateEntity(entity, changes);

      expect(entity.updatedBy).toBeNull();
    });

    // F-01. The `updatedBy` stamp used to run BEFORE the DTO changes were
    // applied. Because the stamp routes through change tracking, a semantically
    // empty update on a row whose previous editor was somebody else (or on a
    // freshly created row, where `updatedBy` is still NULL) registered
    // `updatedBy` as a real change — so `hasChanges` was true, every
    // caller's `if (!entity.hasChanges) throw` guard was bypassed, and the
    // no-op write committed: version bump, `updatedAt` rewrite, and a
    // ResourceUpdated audit row for a request that changed nothing. The
    // identical request then returned 400 on the SECOND attempt, because by
    // then the stamp was value-identical. The contract was history-dependent.
    //
    // The stamp is now applied only when the DTO staged a real change, so an
    // empty update is deterministically empty regardless of row history.
    it('does not stamp updatedBy when the change set is semantically empty (fresh row)', async () => {
      const entity = new MockEntity(); // updatedBy === null, as on a freshly created row
      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-123' } : null));

      await service.testUpdateEntity(entity, {});

      expect(entity.updatedBy).toBeNull();
      expect(entity.hasChanges).toBe(false);
      expect(entity.changes).toEqual({});
    });

    it('does not stamp updatedBy when a different user submits a no-op update', async () => {
      const entity = new MockEntity();
      entity.updatedBy = 'previous-editor';
      // Clear the tracked change so the entity looks like a row loaded from the DB.
      for (const key of Object.keys(entity.changes)) delete (entity.changes as Record<string, unknown>)[key];

      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-123' } : null));

      await service.testUpdateEntity(entity, { name: undefined });

      expect(entity.updatedBy).toBe('previous-editor');
      expect(entity.hasChanges).toBe(false);
    });

    it('still stamps updatedBy when the DTO carries a real change', async () => {
      const entity = new MockEntity();
      entity.updatedBy = 'previous-editor';
      for (const key of Object.keys(entity.changes)) delete (entity.changes as Record<string, unknown>)[key];

      mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'user-123' } : null));

      await service.testUpdateEntity(entity, { name: 'New Name' });

      expect(entity.name).toBe('New Name');
      expect(entity.updatedBy).toBe('user-123');
      expect(entity.changes).toEqual({ name: 'New Name', updatedBy: 'user-123' });
    });
  });
});
