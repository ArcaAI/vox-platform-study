/**
 * EventThrottleService Unit Tests
 *
 * Tests for the EventThrottleService that prevents excessive audit logging
 * for high-frequency READ events.
 *
 * Testing Strategy:
 * - Tests verify throttling behavior for READ vs non-READ actions
 * - Tests verify cache management (cleanup, size limits)
 * - Tests verify per-user throttling capability
 * - Tests verify configurable time windows
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventThrottleService } from '../event-throttle.service';
import { AuditAction, ResourceType } from '@arcaai/domains';

describe('EventThrottleService', () => {
  let service: EventThrottleService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new EventThrottleService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('shouldLog', () => {
    describe('non-READ actions', () => {
      it('should always return true for CREATE action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.CREATE);
        expect(result).toBe(true);
      });

      it('should always return true for UPDATE action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.UPDATE);
        expect(result).toBe(true);
      });

      it('should always return true for DELETE action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.DELETE);
        expect(result).toBe(true);
      });

      it('should always return true for ARCHIVE action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.ARCHIVE);
        expect(result).toBe(true);
      });

      it('should always return true for LOGIN action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.LOGIN);
        expect(result).toBe(true);
      });

      it('should always return true for LOGOUT action', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.LOGOUT);
        expect(result).toBe(true);
      });

      it('should allow multiple consecutive non-READ actions', () => {
        // Multiple CREATE actions should all return true
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.CREATE)).toBe(true);
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.CREATE)).toBe(true);
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.CREATE)).toBe(true);
      });
    });

    describe('READ actions - throttling behavior', () => {
      it('should return true for first READ of a resource', () => {
        const result = service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ);
        expect(result).toBe(true);
      });

      it('should return false for second READ within throttle window', () => {
        // First read
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

        // Second read immediately after (within 5s window)
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);
      });

      it('should return true for READ after throttle window expires', () => {
        // First read
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

        // Second read immediately (throttled)
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);

        // Advance time past throttle window (default 5s)
        vi.advanceTimersByTime(5001);

        // Third read after window expires
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);
      });

      it('should track different resources independently', () => {
        // Read user-1
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(true);

        // Read user-2 (different resource)
        expect(service.shouldLog(ResourceType.User, 'user-2', AuditAction.READ)).toBe(true);

        // Read user-1 again (should be throttled)
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(false);

        // Read user-2 again (should also be throttled)
        expect(service.shouldLog(ResourceType.User, 'user-2', AuditAction.READ)).toBe(false);
      });

      it('should track different resource types independently', () => {
        // Read User
        expect(service.shouldLog(ResourceType.User, 'id-123', AuditAction.READ)).toBe(true);

        // Read Consultation with same ID (different resource type)
        expect(service.shouldLog(ResourceType.Consultation, 'id-123', AuditAction.READ)).toBe(true);

        // Both should be throttled now
        expect(service.shouldLog(ResourceType.User, 'id-123', AuditAction.READ)).toBe(false);
        expect(service.shouldLog(ResourceType.Consultation, 'id-123', AuditAction.READ)).toBe(false);
      });

      it('should return true for READ when resourceId is undefined', () => {
        // Can't throttle without an identifier
        expect(service.shouldLog(ResourceType.User, undefined, AuditAction.READ)).toBe(true);
        expect(service.shouldLog(ResourceType.User, undefined, AuditAction.READ)).toBe(true);
      });
    });

    describe('per-user throttling', () => {
      it('should track same resource differently for different users', () => {
        // User A reads resource
        expect(service.shouldLog(ResourceType.Consultation, 'cons-123', AuditAction.READ, 'user-A')).toBe(true);

        // User B reads same resource (not throttled - different user)
        expect(service.shouldLog(ResourceType.Consultation, 'cons-123', AuditAction.READ, 'user-B')).toBe(true);

        // User A reads same resource again (throttled)
        expect(service.shouldLog(ResourceType.Consultation, 'cons-123', AuditAction.READ, 'user-A')).toBe(false);

        // User B reads same resource again (throttled)
        expect(service.shouldLog(ResourceType.Consultation, 'cons-123', AuditAction.READ, 'user-B')).toBe(false);
      });

      it('should use global throttle when userId is not provided', () => {
        // Global read (no userId)
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

        // Another global read (throttled)
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);
      });

      it('should treat global and user-specific reads separately', () => {
        // Global read
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

        // User-specific read (not throttled - different key)
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ, 'user-A')).toBe(true);

        // Both should be throttled now
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);
        expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ, 'user-A')).toBe(false);
      });
    });
  });

  describe('configurable throttle window', () => {
    it('should use custom throttle window', () => {
      const customService = new EventThrottleService({ windowMs: 1000 }); // 1 second

      // First read
      expect(customService.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

      // Advance 500ms (still within window)
      vi.advanceTimersByTime(500);
      expect(customService.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);

      // Advance another 600ms (past window)
      vi.advanceTimersByTime(600);
      expect(customService.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);
    });

    it('should use default 5s window when not configured', () => {
      // First read
      expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);

      // At 4999ms (still within window)
      vi.advanceTimersByTime(4999);
      expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(false);

      // At 5001ms (past window)
      vi.advanceTimersByTime(2);
      expect(service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ)).toBe(true);
    });
  });

  describe('cache management', () => {
    describe('getCacheSize', () => {
      it('should return 0 for empty cache', () => {
        expect(service.getCacheSize()).toBe(0);
      });

      it('should return correct count after reads', () => {
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);
        expect(service.getCacheSize()).toBe(1);

        service.shouldLog(ResourceType.User, 'user-2', AuditAction.READ);
        expect(service.getCacheSize()).toBe(2);

        service.shouldLog(ResourceType.User, 'user-3', AuditAction.READ);
        expect(service.getCacheSize()).toBe(3);
      });

      it('should not increase cache size for non-READ actions', () => {
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.CREATE);
        expect(service.getCacheSize()).toBe(0);

        service.shouldLog(ResourceType.User, 'user-2', AuditAction.UPDATE);
        expect(service.getCacheSize()).toBe(0);
      });

      it('should not increase cache size for duplicate READ within window', () => {
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);
        expect(service.getCacheSize()).toBe(1);

        // Same resource read (updates existing entry, doesn't add new one)
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);
        expect(service.getCacheSize()).toBe(1);
      });
    });

    describe('clearCache', () => {
      it('should clear all entries', () => {
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);
        service.shouldLog(ResourceType.User, 'user-2', AuditAction.READ);
        service.shouldLog(ResourceType.User, 'user-3', AuditAction.READ);
        expect(service.getCacheSize()).toBe(3);

        service.clearCache();

        expect(service.getCacheSize()).toBe(0);
      });

      it('should allow reads immediately after clear', () => {
        service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(false);

        service.clearCache();

        // Should be allowed again after clear
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(true);
      });
    });

    describe('automatic cleanup', () => {
      it('should trigger cleanup when cache exceeds maxCacheSize', () => {
        const smallCacheService = new EventThrottleService({
          maxCacheSize: 5,
          cleanupThreshold: 3,
          windowMs: 1000,
        });

        // Add first batch of entries
        for (let i = 0; i < 3; i++) {
          smallCacheService.shouldLog(ResourceType.User, `user-${i}`, AuditAction.READ);
        }

        // Advance time so first entries are expired
        vi.advanceTimersByTime(1500);

        // Add more entries to exceed maxCacheSize and trigger cleanup
        for (let i = 3; i < 8; i++) {
          smallCacheService.shouldLog(ResourceType.User, `user-${i}`, AuditAction.READ);
        }

        // Cache should be cleaned up (expired entries removed)
        // After cleanup, only the fresh entries should remain
        expect(smallCacheService.getCacheSize()).toBeLessThanOrEqual(5);
      });

      it('should remove expired entries during cleanup', () => {
        const smallCacheService = new EventThrottleService({
          maxCacheSize: 3,
          cleanupThreshold: 2,
          windowMs: 1000,
        });

        // Add first entry
        smallCacheService.shouldLog(ResourceType.User, 'user-1', AuditAction.READ);

        // Advance time past window
        vi.advanceTimersByTime(1500);

        // Add more entries to trigger cleanup
        smallCacheService.shouldLog(ResourceType.User, 'user-2', AuditAction.READ);
        smallCacheService.shouldLog(ResourceType.User, 'user-3', AuditAction.READ);
        smallCacheService.shouldLog(ResourceType.User, 'user-4', AuditAction.READ);

        // user-1 should have been cleaned up as it was expired
        // Read should be allowed again
        expect(smallCacheService.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(true);
      });
    });
  });

  describe('isThrottled', () => {
    it('should return false for resource that was never read', () => {
      expect(service.isThrottled(ResourceType.User, 'user-123')).toBe(false);
    });

    it('should return true for recently read resource', () => {
      service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ);

      expect(service.isThrottled(ResourceType.User, 'user-123')).toBe(true);
    });

    it('should return false after throttle window expires', () => {
      service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ);

      vi.advanceTimersByTime(5001);

      expect(service.isThrottled(ResourceType.User, 'user-123')).toBe(false);
    });

    it('should check user-specific throttle when userId provided', () => {
      service.shouldLog(ResourceType.User, 'user-123', AuditAction.READ, 'user-A');

      // Should be throttled for user-A
      expect(service.isThrottled(ResourceType.User, 'user-123', 'user-A')).toBe(true);

      // Should not be throttled for user-B
      expect(service.isThrottled(ResourceType.User, 'user-123', 'user-B')).toBe(false);

      // Global check should also be false
      expect(service.isThrottled(ResourceType.User, 'user-123')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should always allow empty string resourceId (cannot throttle without identifier)', () => {
      // Empty string is falsy, so !resourceId returns true - always allows logging
      expect(service.shouldLog(ResourceType.User, '', AuditAction.READ)).toBe(true);
      expect(service.shouldLog(ResourceType.User, '', AuditAction.READ)).toBe(true);
      expect(service.shouldLog(ResourceType.User, '', AuditAction.READ)).toBe(true);
    });

    it('should handle very long resourceId', () => {
      const longId = 'a'.repeat(1000);
      expect(service.shouldLog(ResourceType.User, longId, AuditAction.READ)).toBe(true);
      expect(service.shouldLog(ResourceType.User, longId, AuditAction.READ)).toBe(false);
    });

    it('should handle special characters in resourceId', () => {
      const specialId = 'user:123:test@example.com';
      expect(service.shouldLog(ResourceType.User, specialId, AuditAction.READ)).toBe(true);
      expect(service.shouldLog(ResourceType.User, specialId, AuditAction.READ)).toBe(false);
    });

    it('should handle rapid successive reads', () => {
      // Rapid reads should all be throttled after first
      expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(true);
      for (let i = 0; i < 100; i++) {
        expect(service.shouldLog(ResourceType.User, 'user-1', AuditAction.READ)).toBe(false);
      }
    });

    it('should handle all resource types', () => {
      const resourceTypes: ResourceType[] = [
        ResourceType.User,
        ResourceType.Consultation,
        ResourceType.Tag,
        ResourceType.Media,
        ResourceType.Tenant,
        ResourceType.Role,
        ResourceType.Permission,
      ];

      resourceTypes.forEach((resourceType) => {
        expect(service.shouldLog(resourceType, 'id-1', AuditAction.READ)).toBe(true);
        expect(service.shouldLog(resourceType, 'id-1', AuditAction.READ)).toBe(false);
      });
    });
  });

  describe('realistic usage scenarios', () => {
    it('should handle user browsing multiple consultations', () => {
      const userId = 'doctor-123';

      // Doctor opens consultation list (list view - not logged individually)
      // Doctor opens consultation 1
      expect(service.shouldLog(ResourceType.Consultation, 'cons-1', AuditAction.READ, userId)).toBe(true);

      // Doctor switches to consultation 2
      expect(service.shouldLog(ResourceType.Consultation, 'cons-2', AuditAction.READ, userId)).toBe(true);

      // Doctor goes back to consultation 1 (throttled)
      expect(service.shouldLog(ResourceType.Consultation, 'cons-1', AuditAction.READ, userId)).toBe(false);

      // Doctor opens consultation 3
      expect(service.shouldLog(ResourceType.Consultation, 'cons-3', AuditAction.READ, userId)).toBe(true);

      // After 5 seconds, doctor can view cons-1 again
      vi.advanceTimersByTime(5001);
      expect(service.shouldLog(ResourceType.Consultation, 'cons-1', AuditAction.READ, userId)).toBe(true);
    });

    it('should handle multiple users accessing same resource', () => {
      // User A accesses resource
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-A')).toBe(true);

      // User B accesses same resource (allowed - different user)
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-B')).toBe(true);

      // User C accesses same resource (allowed - different user)
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-C')).toBe(true);

      // All users are now throttled for this resource
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-A')).toBe(false);
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-B')).toBe(false);
      expect(service.shouldLog(ResourceType.User, 'shared-doc', AuditAction.READ, 'user-C')).toBe(false);
    });
  });
});
