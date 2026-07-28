/**
 * AuthorizationAuditService Unit Tests
 *
 * Tests for the AuthorizationAuditService that handles authorization audit logging.
 *
 * Testing Strategy:
 * - Tests verify actual audit logging behavior and data integrity
 * - Database operations are mocked at the Prisma boundary
 * - Redis operations are mocked at the cache service boundary
 * - Error handling tests verify graceful degradation (non-blocking audit)
 * - Tests verify both allowed and denied authorization decisions
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { AuthorizationAuditService, AuthorizationAuditEntry, AuditHistoryOptions } from '../authorization-audit.service';

vi.mock('@nestjs/common', async () => {
  const actual = await vi.importActual('@nestjs/common');
  return {
    ...actual,
    Logger: class MockLogger {
      log = vi.fn();
      debug = vi.fn();
      warn = vi.fn();
      error = vi.fn();
    },
  };
});

// Mock CoreDatabaseService (Prisma boundary)
const mockPrismaClient = {
  auditLog: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
};

const mockDatabaseService = {
  client: mockPrismaClient,
};

// Mock Redis Cache Service (external boundary)
const mockCacheService = {
  isConnected: vi.fn(),
  publish: vi.fn(),
  setex: vi.fn(),
};

// Mock ClsService (CLS boundary) — kept here so tenant-scoping tests
// can opt-in by passing it to the constructor.
const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
};

describe('AuthorizationAuditService', () => {
  let service: AuthorizationAuditService;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default: Redis is connected
    mockCacheService.isConnected.mockReturnValue(true);
    mockCacheService.publish.mockResolvedValue(undefined);
    mockCacheService.setex.mockResolvedValue(undefined);

    // Default CLS context: Tenant A admin (no GLOBAL_ADMIN role)
    mockClsService.get.mockImplementation((key: string) => {
      switch (key) {
        case 'tenantId':
          return 'tenant-a';
        case 'user':
          return { id: 'admin-a', roles: ['TenantAdmin'] };
        default:
          return null;
      }
    });

    // Default service: constructed WITH the CLS mock so tenant scoping
    // is enabled. The "service without Redis cache" describe block below
    // continues to omit it (verifying the @Optional() boundary).
    service = new AuthorizationAuditService(mockDatabaseService as any, mockCacheService as any, mockClsService as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('logAuthorizationDecision', () => {
    const baseEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
      userId: 'user-123',
      action: 'read',
      subject: 'User',
      resourceId: 'resource-456',
      allowed: true,
      endpoint: '/api/users/123',
      method: 'GET',
      tenantId: 'tenant-1',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
    };

    it('should log allowed authorization decision successfully', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          eventType: 'AUTHORIZATION',
          responsibleUserId: 'user-123',
          // Persisted `tenantId` is now CLS-derived
          // (`tenant-a` from `beforeEach`), not the caller-supplied
          // `entry.tenantId` (`tenant-1`).
          tenantId: 'tenant-a',
          action: 'READ', // Action is uppercased to match AuditAction enum
          resourceType: 'User',
          resourceId: 'resource-456',
          success: true,
          data: {}, // Required field for audit log
          previousData: {}, // Required field for audit log
          metadata: expect.objectContaining({
            endpoint: '/api/users/123',
            method: 'GET',
            ipAddress: '192.168.1.1',
            userAgent: 'Mozilla/5.0',
          }),
        }),
      });
    });

    it('should log denied authorization decision successfully', async () => {
      const deniedEntry = {
        ...baseEntry,
        allowed: false,
        reason: 'Insufficient permissions',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(deniedEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          success: false,
          metadata: expect.objectContaining({
            reason: 'Insufficient permissions',
          }),
        }),
      });
    });

    it('should publish to Redis when connected', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCacheService.publish).toHaveBeenCalledWith('authorization:audit', expect.any(String));
    });

    it('should not publish to Redis when not connected', async () => {
      mockCacheService.isConnected.mockReturnValue(false);
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCacheService.publish).not.toHaveBeenCalled();
    });

    it('should track denial in Redis when access is denied', async () => {
      const deniedEntry = {
        ...baseEntry,
        allowed: false,
        reason: 'Access denied',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(deniedEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCacheService.setex).toHaveBeenCalledWith(
        expect.stringContaining('authorization:recent-denials:user-123:'),
        3600,
        expect.any(String),
      );
    });

    it('should not track denial in Redis when access is allowed', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCacheService.setex).not.toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      mockPrismaClient.auditLog.create.mockRejectedValue(new Error('Database error'));

      // Should not throw
      await expect(service.logAuthorizationDecision(baseEntry)).resolves.toBeUndefined();
    });

    it('should handle Redis publish errors gracefully', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });
      mockCacheService.publish.mockRejectedValue(new Error('Redis error'));

      // Should not throw
      await expect(service.logAuthorizationDecision(baseEntry)).resolves.toBeUndefined();
    });

    it('should handle Redis setex errors gracefully for denials', async () => {
      const deniedEntry = { ...baseEntry, allowed: false };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });
      mockCacheService.setex.mockRejectedValue(new Error('Redis error'));

      // Should not throw
      await expect(service.logAuthorizationDecision(deniedEntry)).resolves.toBeUndefined();
    });

    it('should add timestamp to entry', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });
      const beforeTime = new Date();

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          createdAt: expect.any(Date),
        }),
      });

      const callArgs = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(callArgs.data.createdAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
    });
  });

  describe('getAuthorizationHistory', () => {
    const mockLogs = [
      {
        responsibleUserId: 'user-123',
        action: 'read',
        resourceType: 'User',
        resourceId: 'res-1',
        success: true,
        eventType: 'AUTHORIZATION',
        metadata: { endpoint: '/api/users', method: 'GET' },
        createdAt: new Date('2026-01-30T10:00:00Z'),
        tenantId: 'tenant-1',
      },
      {
        responsibleUserId: 'user-123',
        action: 'update',
        resourceType: 'User',
        resourceId: 'res-2',
        success: false,
        eventType: 'AUTHORIZATION',
        metadata: { endpoint: '/api/users/1', method: 'PUT', reason: 'Denied' },
        createdAt: new Date('2026-01-30T09:00:00Z'),
        tenantId: 'tenant-1',
      },
    ];

    it('should return authorization history for a user', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue(mockLogs);

      const result = await service.getAuthorizationHistory('user-123');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(
        expect.objectContaining({
          userId: 'user-123',
          action: 'read',
          subject: 'User',
          allowed: true,
        }),
      );
    });

    it('should apply default limit of 100', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getAuthorizationHistory('user-123');

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100,
        }),
      );
    });

    it('should apply custom limit', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getAuthorizationHistory('user-123', { limit: 50 });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
        }),
      );
    });

    it('should filter by since date', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);
      const since = new Date('2026-01-29T00:00:00Z');

      await service.getAuthorizationHistory('user-123', { since });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: since },
          }),
        }),
      );
    });

    it('should filter by action', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getAuthorizationHistory('user-123', { action: 'read' });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            action: 'READ', // Action is uppercased to match AuditAction enum
          }),
        }),
      );
    });

    it('should filter by subject', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getAuthorizationHistory('user-123', { subject: 'User' });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            resourceType: 'User',
          }),
        }),
      );
    });

    it('should filter by allowed status', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getAuthorizationHistory('user-123', { allowed: false });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            success: false,
          }),
        }),
      );
    });

    it('should return empty array when AuditLog model is not available', async () => {
      mockPrismaClient.auditLog.findMany.mockRejectedValue(new Error('Model not available'));

      const result = await service.getAuthorizationHistory('user-123');

      expect(result).toEqual([]);
    });

    it('should return empty array when no logs found', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue(null);

      const result = await service.getAuthorizationHistory('user-123');

      expect(result).toEqual([]);
    });

    it('should map database results to AuthorizationAuditEntry format', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([mockLogs[0]]);

      const result = await service.getAuthorizationHistory('user-123');

      expect(result[0]).toEqual({
        userId: 'user-123', // responsibleUserId is mapped back to userId
        action: 'read',
        subject: 'User',
        resourceId: 'res-1',
        allowed: true,
        endpoint: '/api/users',
        method: 'GET',
        reason: undefined,
        timestamp: mockLogs[0].createdAt,
        tenantId: 'tenant-1',
        ipAddress: undefined,
      });
    });
  });

  describe('getRecentDenials', () => {
    const mockDenials = [
      {
        userId: 'user-123',
        action: 'delete',
        resourceType: 'User',
        resourceId: 'res-1',
        success: false,
        metadata: { endpoint: '/api/users/1', method: 'DELETE', reason: 'Forbidden' },
        createdAt: new Date('2026-01-30T10:00:00Z'),
        tenantId: 'tenant-1',
      },
    ];

    it('should return recent denied access attempts', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue(mockDenials);

      const result = await service.getRecentDenials();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(
        expect.objectContaining({
          allowed: false,
          action: 'delete',
        }),
      );
    });

    it('should apply default limit of 50', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getRecentDenials();

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50,
        }),
      );
    });

    it('should filter by since date', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);
      const since = new Date('2026-01-29T00:00:00Z');

      await service.getRecentDenials({ since });

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gte: since },
          }),
        }),
      );
    });

    it('should always filter for denied entries only', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getRecentDenials();

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            success: false,
          }),
        }),
      );
    });

    it('should return empty array when AuditLog model is not available', async () => {
      mockPrismaClient.auditLog.findMany.mockRejectedValue(new Error('Model not available'));

      const result = await service.getRecentDenials();

      expect(result).toEqual([]);
    });

    it('should return empty array when no denials found', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue(null);

      const result = await service.getRecentDenials();

      expect(result).toEqual([]);
    });
  });

  describe('getDenialCount', () => {
    it('should return count of denials for a user within default window', async () => {
      const mockDenials = [
        { userId: 'user-123', success: false },
        { userId: 'user-123', success: false },
        { userId: 'user-123', success: false },
      ];
      mockPrismaClient.auditLog.findMany.mockResolvedValue(
        mockDenials.map((d) => ({
          ...d,
          action: 'read',
          resourceType: 'User',
          metadata: { endpoint: '/api', method: 'GET' },
          createdAt: new Date(),
          tenantId: 'tenant-1',
        })),
      );

      const result = await service.getDenialCount('user-123');

      expect(result).toBe(3);
    });

    it('should use default window of 60 minutes', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getDenialCount('user-123');

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
            }),
          }),
        }),
      );

      const callArgs = mockPrismaClient.auditLog.findMany.mock.calls[0][0];
      const sinceDate = callArgs.where.createdAt.gte;
      const expectedMinTime = Date.now() - 60 * 60 * 1000 - 1000; // 60 minutes ago with 1s buffer
      expect(sinceDate.getTime()).toBeGreaterThan(expectedMinTime);
    });

    it('should use custom window minutes', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      await service.getDenialCount('user-123', 30);

      expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: expect.objectContaining({
              gte: expect.any(Date),
            }),
          }),
        }),
      );

      const callArgs = mockPrismaClient.auditLog.findMany.mock.calls[0][0];
      const sinceDate = callArgs.where.createdAt.gte;
      const expectedMinTime = Date.now() - 30 * 60 * 1000 - 1000; // 30 minutes ago with 1s buffer
      expect(sinceDate.getTime()).toBeGreaterThan(expectedMinTime);
    });

    it('should return 0 when no denials found', async () => {
      mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

      const result = await service.getDenialCount('user-123');

      expect(result).toBe(0);
    });
  });

  describe('service without Redis cache', () => {
    let serviceWithoutCache: AuthorizationAuditService;

    beforeEach(() => {
      serviceWithoutCache = new AuthorizationAuditService(
        mockDatabaseService as any,
        undefined, // No cache service
      );
    });

    it('should log to database without Redis operations', async () => {
      const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'user-123',
        action: 'read',
        subject: 'User',
        allowed: true,
        endpoint: '/api/users',
        method: 'GET',
        // `serviceWithoutCache` is constructed without
        // CLS; supply `entry.tenantId` so the back-compat fallback
        // satisfies the NOT NULL `tenantId` guard introduced in P1.2
        // and the DB write proceeds (test verifies Redis bypass).
        tenantId: 'tenant-background',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await serviceWithoutCache.logAuthorizationDecision(entry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalled();
      expect(mockCacheService.publish).not.toHaveBeenCalled();
      expect(mockCacheService.setex).not.toHaveBeenCalled();
    });
  });

  describe('Authorization Decision Data Integrity', () => {
    const baseEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
      userId: 'user-123',
      action: 'read',
      subject: 'User',
      resourceId: 'resource-456',
      allowed: true,
      endpoint: '/api/users/123',
      method: 'GET',
      tenantId: 'tenant-1',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0',
    };

    it('should preserve all entry fields in database record', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data).toMatchObject({
        eventType: 'AUTHORIZATION',
        responsibleUserId: 'user-123',
        // Persisted `tenantId` is CLS-derived
        // (`tenant-a`), not the caller-supplied `entry.tenantId`.
        tenantId: 'tenant-a',
        action: 'READ', // Action is uppercased to match AuditAction enum
        resourceType: 'User',
        resourceId: 'resource-456',
        success: true,
        data: {},
        previousData: {},
      });
      expect(createCall.data.metadata).toMatchObject({
        endpoint: '/api/users/123',
        method: 'GET',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
      });
    });

    it('should include denial reason in metadata when access denied', async () => {
      const deniedEntry = {
        ...baseEntry,
        allowed: false,
        reason: 'User lacks required permission: users:read',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(deniedEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.metadata.reason).toBe('User lacks required permission: users:read');
    });
  });

  describe('Real-time Monitoring Integration', () => {
    const baseEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
      userId: 'user-123',
      action: 'delete',
      subject: 'Consultation',
      allowed: false,
      endpoint: '/api/consultations/123',
      method: 'DELETE',
      reason: 'Insufficient privileges',
    };

    it('should publish to correct Redis channel', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockCacheService.publish).toHaveBeenCalledWith('authorization:audit', expect.any(String));
    });

    it('should publish complete entry data as JSON', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(baseEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const publishCall = mockCacheService.publish.mock.calls[0];
      const publishedData = JSON.parse(publishCall[1]);

      expect(publishedData.userId).toBe('user-123');
      expect(publishedData.action).toBe('delete');
      expect(publishedData.subject).toBe('Consultation');
      expect(publishedData.allowed).toBe(false);
      expect(publishedData.timestamp).toBeDefined();
    });
  });

  describe('Security Monitoring Features', () => {
    it('should track repeated denial patterns for security analysis', async () => {
      const deniedEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'suspicious-user',
        action: 'admin',
        subject: 'System',
        allowed: false,
        endpoint: '/api/admin/settings',
        method: 'POST',
        reason: 'Admin access denied',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(deniedEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Verify denial is tracked in Redis for quick access
      expect(mockCacheService.setex).toHaveBeenCalledWith(
        expect.stringContaining('authorization:recent-denials:suspicious-user:'),
        3600, // 1 hour TTL
        expect.any(String),
      );
    });

    it('should count denials within time window for rate limiting', async () => {
      const mockDenials = Array.from({ length: 5 }, (_, i) => ({
        userId: 'rate-limited-user',
        action: 'read',
        resourceType: 'Secret',
        success: false,
        metadata: { endpoint: `/api/secrets/${i}`, method: 'GET' },
        createdAt: new Date(),
        tenantId: 'tenant-1',
      }));
      mockPrismaClient.auditLog.findMany.mockResolvedValue(mockDenials);

      const count = await service.getDenialCount('rate-limited-user', 30);

      expect(count).toBe(5);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle multiple concurrent log operations', async () => {
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      const entries = Array.from({ length: 10 }, (_, i) => ({
        userId: `user-${i}`,
        action: 'read',
        subject: 'User',
        allowed: true,
        endpoint: `/api/users/${i}`,
        method: 'GET',
      }));

      // Log all entries concurrently
      await Promise.all(entries.map((entry) => service.logAuthorizationDecision(entry)));

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 50));

      // All should be logged
      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledTimes(10);
    });
  });

  describe('Edge Cases', () => {
    it('should handle missing optional fields gracefully', async () => {
      const minimalEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'user-123',
        action: 'read',
        subject: 'User',
        allowed: true,
        endpoint: '/api/users',
        method: 'GET',
        // No resourceId, tenantId, ipAddress, userAgent, reason
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(minimalEntry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalled();
    });

    it('should handle very long endpoint paths', async () => {
      const longEndpoint = '/api/' + 'nested/'.repeat(100) + 'resource';
      const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'user-123',
        action: 'read',
        subject: 'Resource',
        allowed: true,
        endpoint: longEndpoint,
        method: 'GET',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(entry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.metadata.endpoint).toBe(longEndpoint);
    });

    it('should handle special characters in user agent', async () => {
      const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'user-123',
        action: 'read',
        subject: 'User',
        allowed: true,
        endpoint: '/api/users',
        method: 'GET',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "Special" <chars>',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(entry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.metadata.userAgent).toContain('Mozilla');
    });
  });

  describe('New Schema Fields: eventType and success', () => {
    describe('eventType field', () => {
      it('should always set eventType to AUTHORIZATION for authorization decisions', async () => {
        const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
          userId: 'user-123',
          action: 'read',
          subject: 'User',
          allowed: true,
          endpoint: '/api/users',
          method: 'GET',
        };
        mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        await service.logAuthorizationDecision(entry);

        // Wait for async operations
        await new Promise((resolve) => setTimeout(resolve, 10));

        const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
        expect(createCall.data.eventType).toBe('AUTHORIZATION');
      });
    });

    describe('success field', () => {
      it('should set success=true for allowed authorization', async () => {
        const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
          userId: 'user-123',
          action: 'read',
          subject: 'User',
          allowed: true,
          endpoint: '/api/users',
          method: 'GET',
        };
        mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        await service.logAuthorizationDecision(entry);

        // Wait for async operations
        await new Promise((resolve) => setTimeout(resolve, 10));

        const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
        expect(createCall.data.success).toBe(true);
      });

      it('should set success=false for denied authorization', async () => {
        const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
          userId: 'user-123',
          action: 'delete',
          subject: 'User',
          allowed: false,
          endpoint: '/api/users/123',
          method: 'DELETE',
          reason: 'Insufficient permissions',
        };
        mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        await service.logAuthorizationDecision(entry);

        // Wait for async operations
        await new Promise((resolve) => setTimeout(resolve, 10));

        const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
        expect(createCall.data.success).toBe(false);
      });
    });

    describe('required data and previousData fields', () => {
      it('should include empty data object for authorization logs', async () => {
        const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
          userId: 'user-123',
          action: 'read',
          subject: 'User',
          allowed: true,
          endpoint: '/api/users',
          method: 'GET',
        };
        mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

        await service.logAuthorizationDecision(entry);

        // Wait for async operations
        await new Promise((resolve) => setTimeout(resolve, 10));

        const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
        expect(createCall.data.data).toEqual({});
        expect(createCall.data.previousData).toEqual({});
      });
    });
  });

  describe('High-Performance Query Patterns', () => {
    describe('Index: AuditLog_event_user_time_idx (eventType, responsibleUserId, createdAt)', () => {
      it('should query authorization history using optimized index pattern', async () => {
        const mockLogs = [
          {
            responsibleUserId: 'user-123',
            action: 'READ',
            resourceType: 'User',
            success: true,
            eventType: 'AUTHORIZATION',
            metadata: { endpoint: '/api/users', method: 'GET' },
            createdAt: new Date('2026-02-04T10:00:00Z'),
            tenantId: 'tenant-1',
          },
        ];
        mockPrismaClient.auditLog.findMany.mockResolvedValue(mockLogs);

        const result = await service.getAuthorizationHistory('user-123');

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              responsibleUserId: 'user-123',
              eventType: 'AUTHORIZATION',
            }),
            orderBy: { createdAt: 'desc' },
          }),
        );
        expect(result).toHaveLength(1);
      });
    });

    describe('Index: AuditLog_tenant_event_success_time_idx (tenantId, eventType, success, createdAt)', () => {
      it('should query recent denials using optimized index pattern', async () => {
        const mockDenials = [
          {
            responsibleUserId: 'user-456',
            action: 'DELETE',
            resourceType: 'Consultation',
            success: false,
            eventType: 'AUTHORIZATION',
            metadata: { endpoint: '/api/consultations/123', method: 'DELETE', reason: 'Forbidden' },
            createdAt: new Date('2026-02-04T10:00:00Z'),
            tenantId: 'tenant-1',
          },
        ];
        mockPrismaClient.auditLog.findMany.mockResolvedValue(mockDenials);

        const result = await service.getRecentDenials();

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              eventType: 'AUTHORIZATION',
              success: false,
            }),
            orderBy: { createdAt: 'desc' },
          }),
        );
        expect(result).toHaveLength(1);
        expect(result[0].allowed).toBe(false);
      });
    });

    describe('Query with time range filter', () => {
      it('should filter by createdAt for time-based queries', async () => {
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);
        const since = new Date('2026-02-01T00:00:00Z');

        await service.getAuthorizationHistory('user-123', { since });

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              createdAt: { gte: since },
            }),
          }),
        );
      });
    });

    describe('Combined filters for complex queries', () => {
      it('should apply multiple filters efficiently', async () => {
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);
        const since = new Date('2026-02-01T00:00:00Z');

        await service.getAuthorizationHistory('user-123', {
          since,
          action: 'delete',
          subject: 'Consultation',
          allowed: false,
        });

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              responsibleUserId: 'user-123',
              eventType: 'AUTHORIZATION',
              createdAt: { gte: since },
              action: 'DELETE', // Uppercased to match enum
              resourceType: 'Consultation',
              success: false,
            }),
          }),
        );
      });
    });
  });

  describe('Field Mapping: responsibleUserId', () => {
    it('should map userId to responsibleUserId in database', async () => {
      const entry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
        userId: 'user-abc-123',
        action: 'read',
        subject: 'User',
        allowed: true,
        endpoint: '/api/users',
        method: 'GET',
      };
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-1' });

      await service.logAuthorizationDecision(entry);

      // Wait for async operations
      await new Promise((resolve) => setTimeout(resolve, 10));

      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.responsibleUserId).toBe('user-abc-123');
      expect(createCall.data.userId).toBeUndefined(); // Old field should not exist
    });

    it('should map responsibleUserId back to userId in query results', async () => {
      const mockLogs = [
        {
          responsibleUserId: 'user-xyz-789',
          action: 'READ',
          resourceType: 'User',
          success: true,
          eventType: 'AUTHORIZATION',
          metadata: { endpoint: '/api/users', method: 'GET' },
          createdAt: new Date(),
          tenantId: 'tenant-1',
        },
      ];
      mockPrismaClient.auditLog.findMany.mockResolvedValue(mockLogs);

      const result = await service.getAuthorizationHistory('user-xyz-789');

      expect(result[0].userId).toBe('user-xyz-789');
    });
  });

  /**
   * Multi-tenant scoping for raw Prisma audit queries
   *
   * Audit finding C-5 (HIPAA §164.312(b)): `getAuthorizationHistory`,
   * `getRecentDenials`, and `getDenialCount` bypassed `AuditLogRepository`
   * via `(prisma as any).auditLog.findMany(...)` with NO tenant scoping,
   * letting any caller query across all tenants. Methods MUST now inject
   * `tenantId` from CLS into the `where` clause; only GLOBAL_ADMIN may bypass.
   */
  describe('Multi-tenant scoping', () => {
    describe('getAuthorizationHistory', () => {
      it('should inject caller tenantId from CLS into the where clause', async () => {
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getAuthorizationHistory('user-123');

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              tenantId: 'tenant-a',
              responsibleUserId: 'user-123',
              eventType: 'AUTHORIZATION',
            }),
          }),
        );
      });

      it('should NOT inject tenantId for GLOBAL_ADMIN caller', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          switch (key) {
            case 'tenantId':
              return 'tenant-a';
            case 'user':
              return { id: 'super-admin-id', roles: ['GLOBAL_ADMIN'] };
            default:
              return null;
          }
        });
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getAuthorizationHistory('user-123');

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        expect(callWhere.tenantId).toBeUndefined();
        expect(callWhere).toEqual(
          expect.objectContaining({
            responsibleUserId: 'user-123',
            eventType: 'AUTHORIZATION',
          }),
        );
      });

      it('should NOT inject tenantId when no CLS context is wired (back-compat)', async () => {
        const serviceNoCls = new AuthorizationAuditService(mockDatabaseService as any, mockCacheService as any);
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await serviceNoCls.getAuthorizationHistory('user-123');

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        expect(callWhere.tenantId).toBeUndefined();
      });
    });

    describe('getRecentDenials', () => {
      it('should inject caller tenantId from CLS into the where clause', async () => {
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getRecentDenials();

        expect(mockPrismaClient.auditLog.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              tenantId: 'tenant-a',
              eventType: 'AUTHORIZATION',
              success: false,
            }),
          }),
        );
      });

      it('should NOT inject tenantId for GLOBAL_ADMIN caller (cross-tenant denial query)', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          switch (key) {
            case 'tenantId':
              return 'tenant-a';
            case 'user':
              return { id: 'super-admin-id', roles: ['GLOBAL_ADMIN'] };
            default:
              return null;
          }
        });
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getRecentDenials();

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        expect(callWhere.tenantId).toBeUndefined();
      });
    });

    describe('getDenialCount', () => {
      it('should propagate caller tenantId via getAuthorizationHistory', async () => {
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getDenialCount('user-123', 30);

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        expect(callWhere.tenantId).toBe('tenant-a');
        expect(callWhere.responsibleUserId).toBe('user-123');
      });

      it('should NOT scope by tenant for GLOBAL_ADMIN caller', async () => {
        mockClsService.get.mockImplementation((key: string) => {
          switch (key) {
            case 'tenantId':
              return 'tenant-a';
            case 'user':
              return { id: 'super-admin-id', roles: ['GLOBAL_ADMIN'] };
            default:
              return null;
          }
        });
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getDenialCount('user-123');

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        expect(callWhere.tenantId).toBeUndefined();
      });
    });

    describe('Missing tenantId in CLS', () => {
      it('should still inject undefined tenantId (Prisma treats as no filter — log only, no enforcement) — guarded only by GLOBAL_ADMIN path', async () => {
        // When CLS has no tenantId AND caller is not GLOBAL_ADMIN we still
        // refuse to widen the query to all tenants by leaving the
        // explicit `tenantId: undefined` out of the where. This means
        // Prisma matches every row. To prevent that, we filter on a
        // sentinel `null` tenant so the query returns nothing.
        mockClsService.get.mockImplementation((key: string) => {
          switch (key) {
            case 'tenantId':
              return null;
            case 'user':
              return { id: 'user-no-tenant', roles: ['Doctor'] };
            default:
              return null;
          }
        });
        mockPrismaClient.auditLog.findMany.mockResolvedValue([]);

        await service.getAuthorizationHistory('user-123');

        const callWhere = mockPrismaClient.auditLog.findMany.mock.calls[0][0].where;
        // Either `tenantId: null` (filters nothing) or the call is skipped
        // entirely. Our implementation chooses `tenantId: null` to keep
        // the existing AuditLog-model-missing fallback path intact.
        expect(callWhere.tenantId).toBeNull();
      });
    });
  });

  /**
   * (audit C-7 finale / NEW-1 / HIPAA §164.312(b)) — derive
   * the persisted audit row's `tenantId` from CLS, NOT from the caller-
   * supplied `entry.tenantId`. Caller-supplied is allowed only as a
   * back-compat fallback when no CLS context is wired (background jobs).
   * When neither source resolves a tenant, the write is SKIPPED with a
   * warning — audit rows with NULL tenantId would violate the schema
   * NOT NULL constraint.
   */
  describe('logToDatabase uses CLS tenantId', () => {
    const baseEntry: Omit<AuthorizationAuditEntry, 'timestamp'> = {
      userId: 'user-attacker',
      action: 'read',
      subject: 'Consultation',
      resourceId: 'consultation-99',
      allowed: true,
      endpoint: '/api/consultations/99',
      method: 'GET',
      ipAddress: '10.0.0.42',
      userAgent: 'curl/8.0.0',
    };

    it('persists the row with CLS tenantId when CLS is set, ignoring entry.tenantId', async () => {
      // CLS default (beforeEach) returns `tenant-a`. The entry attempts to
      // attribute the row to `tenant-b` — without the guard a Tenant-A
      // caller could mis-attribute audit rows to Tenant B, breaking the
      // HIPAA §164.312(b) audit-integrity contract.
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-x' });

      await service.logAuthorizationDecision({
        ...baseEntry,
        tenantId: 'tenant-b',
      });

      // logToDatabase is fire-and-forget; vi.waitFor polls until the
      // async write lands — robust against slow CI runners (306-F1).
      await vi.waitFor(() => expect(mockPrismaClient.auditLog.create).toHaveBeenCalled());

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledTimes(1);
      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.tenantId).toBe('tenant-a');
    });

    it('falls back to entry.tenantId when no CLS is wired (back-compat for background jobs)', async () => {
      // Constructed without the CLS arg — mirrors background jobs /
      // legacy boot paths that never had a CLS context. The `entry.tenantId`
      // becomes the source of truth in this back-compat mode.
      const serviceNoCls = new AuthorizationAuditService(mockDatabaseService as any, mockCacheService as any);
      mockPrismaClient.auditLog.create.mockResolvedValue({ id: 'audit-y' });

      await serviceNoCls.logAuthorizationDecision({
        ...baseEntry,
        tenantId: 'tenant-from-job',
      });

      await vi.waitFor(() => expect(mockPrismaClient.auditLog.create).toHaveBeenCalled());

      expect(mockPrismaClient.auditLog.create).toHaveBeenCalledTimes(1);
      const createCall = mockPrismaClient.auditLog.create.mock.calls[0][0];
      expect(createCall.data.tenantId).toBe('tenant-from-job');
    });

    it('skips the write and warns when neither CLS nor entry.tenantId resolves', async () => {
      // No CLS, no entry.tenantId — the write would violate the schema
      // NOT NULL on tenantId, so the service skips it and emits a
      // diagnostic so the gap surfaces in logs.
      const serviceNoCls = new AuthorizationAuditService(mockDatabaseService as any, mockCacheService as any);

      await serviceNoCls.logAuthorizationDecision({
        ...baseEntry,
        // No tenantId.
      });

      // The per-instance MockLogger.warn captured the skip diagnostic.
      const loggerWarn = (serviceNoCls as any).logger.warn as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => expect(loggerWarn).toHaveBeenCalled());

      expect(mockPrismaClient.auditLog.create).not.toHaveBeenCalled();
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('AUTH_AUDIT_NO_TENANT'),
        expect.objectContaining({
          userId: 'user-attacker',
          action: 'read',
          subject: 'Consultation',
        }),
      );
    });
  });
});
