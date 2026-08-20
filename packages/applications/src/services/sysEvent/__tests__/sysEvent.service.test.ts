/**
 * SysEventService Unit Tests
 *
 * Tests for the SysEventService that handles system events and dispatches jobs to Redis queues.
 * This service processes events for audit logging, user activity tracking, and system event processing.
 *
 * Testing Strategy:
 * - SysEventService is a BOUNDARY service between the event system and Redis
 * - We mock Redis (external boundary) to test the transformation logic
 * - Tests verify job data structure and conditional dispatch logic
 * - Tests verify async Promise handling and error scenarios
 *
 * Mock Design Principles (following testing-anti-patterns):
 * - Mocks return Promises to match real Redis interface (complete mock structure)
 * - Mocks capture all call arguments for verification
 * - Tests verify actual behavior (data transformation) not just mock calls
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SysEventService } from '../sysEvent.service';
import { SysEvent, SendContactMessageEvent, AuditAction, JobQueue, JobType, ResourceType } from '@arcaai/domains';
import type { QuotaBlockedEvent } from '../../entitlements/entitlements.constants';

/**
 * Mock IRedisService - simulates the Redis queue service.
 *
 * Key design decisions:
 * 1. Returns Promise<void> to match real interface (enables testing async handling)
 * 2. Captures all calls for verification of transformation logic
 * 3. Can be configured to reject promises for error testing
 */
const createMockRedisService = () => ({
  addJob: vi.fn().mockResolvedValue(undefined),
  // Include other methods from IRedisService interface for completeness
  // (even if not used in these tests, prevents incomplete mock anti-pattern)
  getQueue: vi.fn(),
  removeJob: vi.fn(),
});

let mockRedisService = createMockRedisService();

/**
 * Mock IResourceSubscriptionService - complete interface mock.
 * Not directly tested but required by service constructor.
 */
const mockResourceSubscriptionService = {
  subscribe: vi.fn().mockResolvedValue(undefined),
  unsubscribe: vi.fn().mockResolvedValue(undefined),
  getSubscriptions: vi.fn().mockResolvedValue([]),
  isSubscribed: vi.fn().mockResolvedValue(false),
};

/**
 * Creates a complete mock SysEvent matching the real event structure.
 * All fields are populated with sensible defaults to ensure tests
 * don't pass due to incomplete mock data.
 */
const createMockSysEvent = (overrides: Partial<SysEvent> = {}): SysEvent => {
  return {
    id: 'event-id-123',
    resourceId: 'resource-id-456',
    resourceType: ResourceType.User,
    responsibleEntityId: 'user-id-789',
    responsibleEntityType: ResourceType.User,
    responsibleIp: '192.168.1.1',
    disableAuditLog: false,
    forceAuditLog: false, // New field: if true, forces audit logging even for READ events
    data: { key: 'value' },
    previousData: { key: 'old-value' },
    createdAt: new Date('2026-01-30T10:00:00Z'),
    correlationId: 'corr-123',
    tenantId: 'tenant-1',
    ...overrides,
  } as SysEvent;
};

/**
 * Creates a complete mock SendContactMessageEvent for testing
 * email and SMS message dispatching.
 */
const createMockSendContactMessageEvent = (overrides: Partial<SendContactMessageEvent> = {}): SendContactMessageEvent => {
  return {
    id: 'event-id-123',
    resourceId: 'resource-id-456',
    resourceType: ResourceType.User,
    responsibleEntityId: 'user-id-789',
    responsibleEntityType: ResourceType.User,
    responsibleIp: '192.168.1.1',
    disableAuditLog: false,
    forceAuditLog: false,
    data: { key: 'value' },
    previousData: { key: 'old-value' },
    createdAt: new Date('2026-01-30T10:00:00Z'),
    correlationId: 'corr-123',
    tenantId: 'tenant-1',
    messageType: 'email',
    fromResourceId: 'from-email-id',
    targetResourceId: 'to-email-id',
    subject: 'Test Subject',
    message: 'Test message body',
    ...overrides,
  } as SendContactMessageEvent;
};

describe('SysEventService', () => {
  let service: SysEventService;

  beforeEach(() => {
    vi.clearAllMocks();
    // Create fresh mock for each test to ensure isolation
    mockRedisService = createMockRedisService();

    service = new SysEventService(mockRedisService as any, mockResourceSubscriptionService as any);
  });

  describe('handleResourceCreatedEvent', () => {
    it('should create audit log job when disableAuditLog is false', async () => {
      const event = createMockSysEvent({ disableAuditLog: false });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceCreated,
          data: expect.objectContaining({
            action: AuditAction.CREATE,
            responsibleUserId: event.responsibleEntityId,
            responsibleIp: event.responsibleIp,
            resourceId: event.resourceId,
            resourceType: event.resourceType,
          }),
        }),
      );
    });

    it('should skip audit log job when disableAuditLog is true', async () => {
      const event = createMockSysEvent({ disableAuditLog: true });

      await service.handleResourceCreatedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create user activity job when responsible entity is User', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
          jobType: JobType.UserActivity,
          data: expect.objectContaining({
            userId: 'user-123',
            date: event.createdAt,
          }),
        }),
      );
    });

    it('should skip user activity job when responsible entity is not User', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.Tenant,
        responsibleEntityId: 'tenant-123',
      });

      await service.handleResourceCreatedEvent(event);

      const userActivityCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.UserActivity);
      expect(userActivityCalls).toHaveLength(0);
    });

    it('should skip user activity job when responsibleEntityId is missing', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: undefined,
      });

      await service.handleResourceCreatedEvent(event);

      const userActivityCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.UserActivity);
      expect(userActivityCalls).toHaveLength(0);
    });

    it('should always create SysEvent job', async () => {
      const event = createMockSysEvent();

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          jobType: JobType.ResourceCreated,
          data: expect.objectContaining({
            id: event.id,
            data: event,
          }),
        }),
      );
    });

    it('should create all three jobs when conditions are met', async () => {
      const event = createMockSysEvent({
        disableAuditLog: false,
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledTimes(3);

      // Verify each queue was called
      const queueNames = mockRedisService.addJob.mock.calls.map((call) => call[0].queueName);
      expect(queueNames).toContain(JobQueue.AuditLog);
      expect(queueNames).toContain(JobQueue.UserActivity);
      expect(queueNames).toContain(JobQueue.SysEvent);
    });
  });

  describe('handleResourceViewedEvent', () => {
    /**
     * READ operations are NOT logged by default to reduce database load.
     * Only important READ operations with forceAuditLog=true are logged.
     */

    it('should NOT create audit log job by default (READ operations are not logged)', async () => {
      const event = createMockSysEvent({
        disableAuditLog: false,
        forceAuditLog: false, // Default behavior
      });

      await service.handleResourceViewedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create audit log job with READ action when forceAuditLog is true', async () => {
      const event = createMockSysEvent({
        disableAuditLog: false,
        forceAuditLog: true, // Force audit logging for important READ
      });

      await service.handleResourceViewedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceViewed,
          data: expect.objectContaining({
            action: AuditAction.READ,
          }),
        }),
      );
    });

    it('should skip audit log job when disableAuditLog is true even if forceAuditLog is true', async () => {
      const event = createMockSysEvent({
        disableAuditLog: true,
        forceAuditLog: true,
      });

      await service.handleResourceViewedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create user activity job for User entity', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceViewedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
          jobType: JobType.UserActivity,
        }),
      );
    });

    it('should create SysEvent job with ResourceViewed type', async () => {
      const event = createMockSysEvent();

      await service.handleResourceViewedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          jobType: JobType.ResourceViewed,
        }),
      );
    });

    it('should create only UserActivity and SysEvent jobs when forceAuditLog is false', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
        forceAuditLog: false,
      });

      await service.handleResourceViewedEvent(event);

      // Should be 2 jobs: UserActivity + SysEvent (no AuditLog)
      expect(mockRedisService.addJob).toHaveBeenCalledTimes(2);

      const queueNames = mockRedisService.addJob.mock.calls.map((call) => call[0].queueName);
      expect(queueNames).toContain(JobQueue.UserActivity);
      expect(queueNames).toContain(JobQueue.SysEvent);
      expect(queueNames).not.toContain(JobQueue.AuditLog);
    });

    it('should create all three jobs when forceAuditLog is true', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
        forceAuditLog: true,
      });

      await service.handleResourceViewedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledTimes(3);

      const queueNames = mockRedisService.addJob.mock.calls.map((call) => call[0].queueName);
      expect(queueNames).toContain(JobQueue.AuditLog);
      expect(queueNames).toContain(JobQueue.UserActivity);
      expect(queueNames).toContain(JobQueue.SysEvent);
    });
  });

  describe('handleResourceUpdatedEvent', () => {
    it('should create audit log job with UPDATE action', async () => {
      const event = createMockSysEvent({ disableAuditLog: false });

      await service.handleResourceUpdatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceUpdated,
          data: expect.objectContaining({
            action: AuditAction.UPDATE,
          }),
        }),
      );
    });

    it('should skip audit log job when disableAuditLog is true', async () => {
      const event = createMockSysEvent({ disableAuditLog: true });

      await service.handleResourceUpdatedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create user activity job for User entity', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceUpdatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
        }),
      );
    });

    it('should create SysEvent job with ResourceUpdated type', async () => {
      const event = createMockSysEvent();

      await service.handleResourceUpdatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          jobType: JobType.ResourceUpdated,
        }),
      );
    });

    it('should include previousData in audit log', async () => {
      const event = createMockSysEvent({
        data: { name: 'new-name' },
        previousData: { name: 'old-name' },
      });

      await service.handleResourceUpdatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          data: expect.objectContaining({
            data: { name: 'new-name' },
            previousData: { name: 'old-name' },
          }),
        }),
      );
    });
  });

  describe('handleResourceDeletedEvent', () => {
    it('should create audit log job with DELETE action', async () => {
      const event = createMockSysEvent({ disableAuditLog: false });

      await service.handleResourceDeletedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceDeleted,
          data: expect.objectContaining({
            action: AuditAction.DELETE,
          }),
        }),
      );
    });

    it('should skip audit log job when disableAuditLog is true', async () => {
      const event = createMockSysEvent({ disableAuditLog: true });

      await service.handleResourceDeletedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create user activity job for User entity', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceDeletedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
        }),
      );
    });

    it('should create SysEvent job with ResourceDeleted type', async () => {
      const event = createMockSysEvent();

      await service.handleResourceDeletedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          jobType: JobType.ResourceDeleted,
        }),
      );
    });
  });

  describe('handleResourceArchivedEvent', () => {
    it('should create audit log job with ARCHIVE action', async () => {
      const event = createMockSysEvent({ disableAuditLog: false });

      await service.handleResourceArchivedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceArchived,
          data: expect.objectContaining({
            action: AuditAction.ARCHIVE,
          }),
        }),
      );
    });

    it('should skip audit log job when disableAuditLog is true', async () => {
      const event = createMockSysEvent({ disableAuditLog: true });

      await service.handleResourceArchivedEvent(event);

      const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
      expect(auditLogCalls).toHaveLength(0);
    });

    it('should create user activity job for User entity', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      await service.handleResourceArchivedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
        }),
      );
    });

    it('should create SysEvent job with ResourceArchived type', async () => {
      const event = createMockSysEvent();

      await service.handleResourceArchivedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          jobType: JobType.ResourceArchived,
        }),
      );
    });
  });

  describe('handleSendContactMessageEvent', () => {
    describe('email message type', () => {
      it('should create email job when messageType is email', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'email',
          fromResourceId: 'from-email-123',
          targetResourceId: 'to-email-456',
          subject: 'Test Subject',
          message: 'Test message body',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.SendEmail,
            jobType: JobType.SendEmail,
            data: expect.objectContaining({
              fromEmailAddressId: 'from-email-123',
              recipientEmailAddressId: 'to-email-456',
              subject: 'Test Subject',
              body: 'Test message body',
            }),
          }),
        );
      });

      it('should use empty string for subject when not provided', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'email',
          subject: undefined,
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.SendEmail,
            data: expect.objectContaining({
              subject: '',
            }),
          }),
        );
      });
    });

    describe('sms message type', () => {
      it('should create SMS job when messageType is sms', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'sms',
          fromResourceId: 'from-phone-123',
          targetResourceId: 'to-phone-456',
          message: 'Test SMS message',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.SendSms,
            jobType: JobType.SendSms,
            data: expect.objectContaining({
              fromPhoneNumberId: 'from-phone-123',
              recipientPhoneNumberId: 'to-phone-456',
              message: 'Test SMS message',
            }),
          }),
        );
      });

      it('should not create email job when messageType is sms', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'sms',
        });

        await service.handleSendContactMessageEvent(event);

        const emailCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.SendEmail);
        expect(emailCalls).toHaveLength(0);
      });
    });

    describe('audit logging', () => {
      it('should create audit log job when disableAuditLog is false', async () => {
        const event = createMockSendContactMessageEvent({
          disableAuditLog: false,
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.AuditLog,
            jobType: JobType.ResourceCreated,
            data: expect.objectContaining({
              action: AuditAction.CREATE,
            }),
          }),
        );
      });

      it('should skip audit log job when disableAuditLog is true', async () => {
        const event = createMockSendContactMessageEvent({
          disableAuditLog: true,
        });

        await service.handleSendContactMessageEvent(event);

        const auditLogCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.AuditLog);
        expect(auditLogCalls).toHaveLength(0);
      });
    });

    describe('user activity tracking', () => {
      it('should create user activity job when responsible entity is User', async () => {
        const event = createMockSendContactMessageEvent({
          responsibleEntityType: ResourceType.User,
          responsibleEntityId: 'user-123',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.UserActivity,
            jobType: JobType.UserActivity,
            data: expect.objectContaining({
              userId: 'user-123',
            }),
          }),
        );
      });

      it('should skip user activity job when responsible entity is not User', async () => {
        const event = createMockSendContactMessageEvent({
          responsibleEntityType: ResourceType.Tenant,
          responsibleEntityId: 'tenant-123',
        });

        await service.handleSendContactMessageEvent(event);

        const userActivityCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.UserActivity);
        expect(userActivityCalls).toHaveLength(0);
      });
    });

    describe('combined scenarios', () => {
      it('should create email, audit log, and user activity jobs for email with User entity', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'email',
          disableAuditLog: false,
          responsibleEntityType: ResourceType.User,
          responsibleEntityId: 'user-123',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledTimes(3);

        const queueNames = mockRedisService.addJob.mock.calls.map((call) => call[0].queueName);
        expect(queueNames).toContain(JobQueue.SendEmail);
        expect(queueNames).toContain(JobQueue.AuditLog);
        expect(queueNames).toContain(JobQueue.UserActivity);
      });

      it('should create SMS, audit log, and user activity jobs for sms with User entity', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'sms',
          disableAuditLog: false,
          responsibleEntityType: ResourceType.User,
          responsibleEntityId: 'user-123',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledTimes(3);

        const queueNames = mockRedisService.addJob.mock.calls.map((call) => call[0].queueName);
        expect(queueNames).toContain(JobQueue.SendSms);
        expect(queueNames).toContain(JobQueue.AuditLog);
        expect(queueNames).toContain(JobQueue.UserActivity);
      });

      it('should only create email job when audit log disabled and non-User entity', async () => {
        const event = createMockSendContactMessageEvent({
          messageType: 'email',
          disableAuditLog: true,
          responsibleEntityType: ResourceType.Tenant,
          responsibleEntityId: 'tenant-123',
        });

        await service.handleSendContactMessageEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledTimes(1);
        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.SendEmail,
          }),
        );
      });
    });
  });

  describe('edge cases', () => {
    it('should handle event with null data', async () => {
      const event = createMockSysEvent({
        data: null as any,
        previousData: null as any,
      });

      await expect(service.handleResourceCreatedEvent(event)).resolves.toBeUndefined();
    });

    it('should handle event with undefined responsibleIp', async () => {
      const event = createMockSysEvent({
        responsibleIp: undefined,
      });

      await expect(service.handleResourceCreatedEvent(event)).resolves.toBeUndefined();
    });

    it('should handle event with empty string resourceId', async () => {
      const event = createMockSysEvent({
        resourceId: '',
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            resourceId: '',
          }),
        }),
      );
    });

    it('should handle event with complex nested data', async () => {
      const complexData = {
        user: {
          profile: {
            settings: {
              notifications: true,
              theme: 'dark',
            },
          },
        },
        metadata: [1, 2, 3],
      };
      const event = createMockSysEvent({
        data: complexData,
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          data: expect.objectContaining({
            data: complexData,
          }),
        }),
      );
    });

    it('should handle event with undefined responsibleEntityId for non-User entity', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.Tenant,
        responsibleEntityId: undefined,
      });

      await service.handleResourceCreatedEvent(event);

      // Should not create user activity job
      const userActivityCalls = mockRedisService.addJob.mock.calls.filter((call) => call[0].queueName === JobQueue.UserActivity);
      expect(userActivityCalls).toHaveLength(0);
    });

    it('should handle all resource types correctly', async () => {
      const resourceTypes = [ResourceType.User, ResourceType.Tenant, ResourceType.Consultation, ResourceType.Tag, ResourceType.Media];

      for (const resourceType of resourceTypes) {
        mockRedisService = createMockRedisService();
        service = new SysEventService(mockRedisService as any, mockResourceSubscriptionService as any);

        const event = createMockSysEvent({ resourceType });

        await service.handleResourceCreatedEvent(event);

        expect(mockRedisService.addJob).toHaveBeenCalledWith(
          expect.objectContaining({
            queueName: JobQueue.AuditLog,
            data: expect.objectContaining({
              resourceType,
            }),
          }),
        );
      }
    });

    it('should preserve event id in SysEvent job', async () => {
      const event = createMockSysEvent({ id: 'unique-event-id-999' });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          data: expect.objectContaining({
            id: 'unique-event-id-999',
          }),
        }),
      );
    });

    it('should handle event with very long message body', async () => {
      const longMessage = 'A'.repeat(10000);
      const event = createMockSendContactMessageEvent({
        messageType: 'email',
        message: longMessage,
      });

      await service.handleSendContactMessageEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SendEmail,
          data: expect.objectContaining({
            body: longMessage,
          }),
        }),
      );
    });

    it('should handle event with special characters in subject', async () => {
      const specialSubject = 'Test <Subject> with "quotes" & special chars!';
      const event = createMockSendContactMessageEvent({
        messageType: 'email',
        subject: specialSubject,
      });

      await service.handleSendContactMessageEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SendEmail,
          data: expect.objectContaining({
            subject: specialSubject,
          }),
        }),
      );
    });
  });

  describe('async handling and Promise behavior', () => {
    /**
     * These tests verify that the service correctly handles async operations.
     * This addresses Anti-Pattern #1: ensuring we test actual behavior, not just mock calls.
     */

    it('should await all job dispatches before completing', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      // Track call order
      const callOrder: string[] = [];

      mockRedisService.addJob.mockImplementation(async (job) => {
        callOrder.push(`start-${job.queueName}`);
        // Simulate async delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        callOrder.push(`end-${job.queueName}`);
      });

      await service.handleResourceCreatedEvent(event);

      // All jobs should have started before handler returns
      expect(callOrder.filter((c) => c.startsWith('start-'))).toHaveLength(3);
      // All jobs should have completed (Promise.allSettled awaits all)
      expect(callOrder.filter((c) => c.startsWith('end-'))).toHaveLength(3);
    });

    it('should handle partial job failures gracefully (Promise.allSettled)', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      // First job (AuditLog) fails, others succeed
      let callCount = 0;
      mockRedisService.addJob.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Redis connection lost');
        }
        return undefined;
      });

      // Should not throw - Promise.allSettled handles failures gracefully
      await expect(service.handleResourceCreatedEvent(event)).resolves.toBeUndefined();

      // All three jobs should still be attempted
      expect(mockRedisService.addJob).toHaveBeenCalledTimes(3);
    });

    it('should not stop processing when one queue fails', async () => {
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
      });

      const queuesCalled: string[] = [];

      mockRedisService.addJob.mockImplementation(async (job) => {
        queuesCalled.push(job.queueName);
        if (job.queueName === JobQueue.UserActivity) {
          throw new Error('UserActivity queue unavailable');
        }
        return undefined;
      });

      await service.handleResourceCreatedEvent(event);

      // All queues should be attempted despite failure
      expect(queuesCalled).toContain(JobQueue.AuditLog);
      expect(queuesCalled).toContain(JobQueue.UserActivity);
      expect(queuesCalled).toContain(JobQueue.SysEvent);
    });

    it('should complete successfully even when all jobs fail', async () => {
      const event = createMockSysEvent();

      mockRedisService.addJob.mockRejectedValue(new Error('All queues down'));

      // Should not throw
      await expect(service.handleResourceCreatedEvent(event)).resolves.toBeUndefined();
    });
  });

  describe('job data integrity', () => {
    /**
     * These tests verify that data transformation is correct and complete.
     * This addresses Anti-Pattern #4: ensuring our job payloads match what
     * downstream consumers expect.
     */

    it('should include all required fields in audit log job', async () => {
      const event = createMockSysEvent({
        resourceId: 'res-123',
        resourceType: ResourceType.Consultation,
        responsibleEntityId: 'user-456',
        responsibleIp: '10.0.0.1',
        data: { field: 'new-value' },
        previousData: { field: 'old-value' },
        correlationId: 'corr-123',
        tenantId: 'tenant-1',
      });

      await service.handleResourceUpdatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          jobType: JobType.ResourceUpdated,
          data: {
            action: AuditAction.UPDATE,
            responsibleUserId: 'user-456',
            responsibleIp: '10.0.0.1',
            resourceId: 'res-123',
            resourceType: ResourceType.Consultation,
            data: { field: 'new-value' },
            previousData: { field: 'old-value' },
            correlationId: 'corr-123',
            tenantId: 'tenant-1',
          },
        }),
      );
    });

    it('should include timestamp in user activity job', async () => {
      const eventDate = new Date('2026-01-30T15:30:00Z');
      const event = createMockSysEvent({
        responsibleEntityType: ResourceType.User,
        responsibleEntityId: 'user-123',
        createdAt: eventDate,
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.UserActivity,
          data: expect.objectContaining({
            userId: 'user-123',
            date: eventDate,
          }),
        }),
      );
    });

    it('should include complete event in SysEvent job', async () => {
      const event = createMockSysEvent({
        id: 'event-123',
        resourceId: 'res-456',
        data: { important: 'data' },
      });

      await service.handleResourceCreatedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.SysEvent,
          data: expect.objectContaining({
            id: 'event-123',
            data: event,
          }),
        }),
      );
    });

    it('should pass job data by value, not reference (immutability)', async () => {
      const originalData = { field: 'original' };
      const event = createMockSysEvent({
        data: originalData,
      });

      await service.handleResourceCreatedEvent(event);

      // Get the data that was passed to the mock
      const auditLogCall = mockRedisService.addJob.mock.calls.find((call) => call[0].queueName === JobQueue.AuditLog);
      const passedData = auditLogCall[0].data.data;

      // Verify it contains the same values
      expect(passedData).toEqual({ field: 'original' });

      // Modify original after the call
      originalData.field = 'modified';

      // The queued snapshot is a COPY taken at enqueue time (the PHI scrub
      // rebuilds the payload), so a later mutation of the source object can no
      // longer rewrite an already-queued audit row.
      expect(passedData).toEqual({ field: 'original' });
    });
  });

  describe('handleEntitlementsQuotaBlockedEvent', () => {
    /**
     * The payload `EntitlementsService.assertQuantityQuota` /
     * `assertConcurrencyQuota` actually emit on `ENTITLEMENTS_QUOTA_BLOCKED_EVENT`
     * — NOT a `SysEvent` (no `id`, no `resourceType`; `responsibleEntityId` is
     * optional). Previously nobody listened for it at all: a quota block
     * happened, the typed exception was thrown, and the event itself vanished —
     * no audit trail. This is the first real consumer.
     */
    const makeQuotaBlockedEvent = (overrides: Partial<QuotaBlockedEvent> = {}): QuotaBlockedEvent => ({
      tenantId: 'tenant-1',
      capability: 'monthlyTtsCharacters',
      limit: 10_000,
      used: 9_800,
      requested: 500,
      at: new Date('2026-08-06T10:00:00.000Z'),
      ...overrides,
    });

    it('enqueues an AuditLog job carrying the block details, scoped to the tenant', async () => {
      const event = makeQuotaBlockedEvent();

      await service.handleEntitlementsQuotaBlockedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          queueName: JobQueue.AuditLog,
          data: expect.objectContaining({
            action: AuditAction.UPDATE,
            resourceType: ResourceType.Tenant,
            resourceId: 'tenant-1',
            tenantId: 'tenant-1',
            data: expect.objectContaining({
              quotaBlocked: true,
              capability: 'monthlyTtsCharacters',
              limit: 10_000,
              used: 9_800,
              requested: 500,
            }),
          }),
        }),
      );
    });

    it('authors the audit row with responsibleEntityId when the emitting caller supplied one', async () => {
      const event = makeQuotaBlockedEvent({ responsibleEntityId: 'user-42' });

      await service.handleEntitlementsQuotaBlockedEvent(event);

      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ responsibleUserId: 'user-42' }) }),
      );
    });

    it('degrades to an authorless row (never throws) when no responsibleEntityId was supplied', async () => {
      const event = makeQuotaBlockedEvent({ responsibleEntityId: undefined });

      await expect(service.handleEntitlementsQuotaBlockedEvent(event)).resolves.toBeUndefined();
      expect(mockRedisService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ responsibleUserId: undefined }) }),
      );
    });

    it('never throws when the Redis enqueue fails (Promise.allSettled, same posture as every other handler)', async () => {
      mockRedisService.addJob.mockRejectedValueOnce(new Error('queue down'));
      const event = makeQuotaBlockedEvent();

      await expect(service.handleEntitlementsQuotaBlockedEvent(event)).resolves.toBeUndefined();
    });
  });
  describe('PHI scrubbing of audit snapshots', () => {
    const phiEvent = () =>
      createMockSysEvent({
        resourceType: ResourceType.ContextItem,
        data: {
          id: 'ci-1',
          type: 'TRANSCRIPT',
          encryptedContent: Buffer.from('vault:v1:abcdef'),
          content: 'advance before stale approve',
        },
        previousData: {
          id: 'ci-1',
          type: 'TRANSCRIPT',
          encryptedContent: Buffer.from('vault:v1:previous'),
          content: 'patient reports chest pain',
        },
      });

    it('strips PHI plaintext and ciphertext from data and previousData on update', async () => {
      await service.handleResourceUpdatedEvent(phiEvent());

      const auditJob = mockRedisService.addJob.mock.calls.map((c) => c[0]).find((c) => c.queueName === JobQueue.AuditLog);
      expect(auditJob).toBeDefined();
      const serialized = JSON.stringify(auditJob.data);
      expect(serialized).not.toContain('advance before stale approve');
      expect(serialized).not.toContain('patient reports chest pain');
      expect(serialized).not.toContain('"type":"Buffer"');
      // Non-PHI fields still describe the change.
      expect(auditJob.data.data.id).toBe('ci-1');
      expect(auditJob.data.data.type).toBe('TRANSCRIPT');
      expect(Object.keys(auditJob.data.data)).toContain('content');
    });

    it('strips PHI from the created-resource snapshot too', async () => {
      await service.handleResourceCreatedEvent(phiEvent());

      const auditJob = mockRedisService.addJob.mock.calls.map((c) => c[0]).find((c) => c.queueName === JobQueue.AuditLog);
      expect(JSON.stringify(auditJob.data)).not.toContain('advance before stale approve');
    });

    it('leaves a non-PHI resource payload untouched', async () => {
      const event = createMockSysEvent({ resourceType: ResourceType.User, data: { id: 'u-1', email: 'a@b.c' } });

      await service.handleResourceUpdatedEvent(event);

      const auditJob = mockRedisService.addJob.mock.calls.map((c) => c[0]).find((c) => c.queueName === JobQueue.AuditLog);
      expect(auditJob.data.data).toEqual({ id: 'u-1', email: 'a@b.c' });
    });
  });
});
