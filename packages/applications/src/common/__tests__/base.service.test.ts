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

// Mock BaseEntity for testing
class MockEntity {
  private _changes: Record<string, unknown> = {};
  public updatedBy: string | null = null;

  get changes() {
    return this._changes;
  }

  setChange(key: string, value: unknown) {
    this._changes[key] = value;
  }
}

// Concrete implementation for testing
class TestService extends BaseService {
  constructor() {
    super(
      mockEventEmitter as unknown as EventEmitter2,
      mockClsService as any,
      'TestResource' as any
    );
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
        })
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
  describe('TASK-306 P3.1 — broadcastSysEvent CLS wins on tenantId', () => {
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

    // A GLOBAL_ADMIN authenticates with an empty CLS tenantId and
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
  });
});
