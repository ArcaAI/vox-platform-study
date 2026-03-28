import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, ResourceType } from '@arcaai/domains';

/**
 * Configuration options for event throttling.
 */
export interface ThrottleConfig {
  /** Time window in milliseconds for throttling (default: 5000ms) */
  windowMs?: number;
  /** Maximum cache size before cleanup is triggered (default: 10000) */
  maxCacheSize?: number;
  /** Cleanup threshold - when cache reaches this size, older entries are removed (default: 8000) */
  cleanupThreshold?: number;
}

/**
 * Event Throttle Service
 *
 * @deprecated This service is not currently wired into the event pipeline.
 * READ event throttling is handled by the `forceAuditLog` flag in SysEventService instead,
 * which is a simpler approach that doesn't require in-memory state.
 *
 * The `forceAuditLog` approach is preferred because:
 * 1. It scales across multiple application instances (no shared in-memory cache)
 * 2. The decision is made at emit-time by the service author, not at processing time
 * 3. It's explicit — each service decides which READs are important enough to audit
 *
 * This service remains available for potential future use in single-instance scenarios
 * or as supplementary throttling on top of the forceAuditLog flag.
 *
 * Features:
 * - Configurable time window for throttling
 * - Automatic cache cleanup to prevent memory leaks
 * - Per-resource tracking with user context
 * - Only throttles READ actions by default
 *
 * @example
 * ```typescript
 * // If you need in-memory throttling in a single-instance deployment:
 * if (this.throttleService.shouldLog(event.resourceType, event.resourceId, AuditAction.READ)) {
 *     await this.redisService.addJob<AuditLogJob>({...});
 * }
 * ```
 */
@Injectable()
export class EventThrottleService {
  private readonly logger = new Logger(EventThrottleService.name);

  /**
   * Cache storing the last logged timestamp for each resource.
   * Key format: `${resourceType}:${resourceId}:${userId}`
   */
  private readonly viewedCache = new Map<string, number>();

  /** Time window in milliseconds for throttling */
  private readonly throttleWindowMs: number;

  /** Maximum cache size before cleanup is triggered */
  private readonly maxCacheSize: number;

  /** Cleanup threshold */
  private readonly cleanupThreshold: number;

  constructor(config: ThrottleConfig = {}) {
    this.throttleWindowMs = config.windowMs ?? 5000; // 5 seconds default
    this.maxCacheSize = config.maxCacheSize ?? 10000;
    this.cleanupThreshold = config.cleanupThreshold ?? 8000;

    this.logger.log({
      message: 'EventThrottleService initialized',
      throttleWindowMs: this.throttleWindowMs,
      maxCacheSize: this.maxCacheSize,
    });
  }

  /**
   * Determine whether an audit log should be created for this event.
   * Only throttles READ actions to prevent duplicate view logs within the time window.
   *
   * @param resourceType - The type of resource being accessed
   * @param resourceId - The ID of the resource being accessed
   * @param action - The action being performed (CREATE, READ, UPDATE, DELETE)
   * @param userId - Optional user ID for per-user throttling
   * @returns true if the event should be logged, false if it should be throttled
   */
  shouldLog(resourceType: ResourceType, resourceId: string | undefined, action: AuditAction, userId?: string): boolean {
    // Only throttle READ actions - all other actions should always be logged
    if (action !== AuditAction.READ) {
      return true;
    }

    // If no resourceId, always log (can't throttle without an identifier)
    if (!resourceId) {
      return true;
    }

    // Generate cache key including user to allow per-user throttling
    const key = userId ? `${resourceType}:${resourceId}:${userId}` : `${resourceType}:${resourceId}`;

    const now = Date.now();
    const lastLogged = this.viewedCache.get(key);

    // Check if this resource was logged within the throttle window
    if (lastLogged && now - lastLogged < this.throttleWindowMs) {
      this.logger.debug({
        message: 'Event throttled',
        resourceType,
        resourceId,
        userId,
        timeSinceLastLog: now - lastLogged,
        throttleWindowMs: this.throttleWindowMs,
      });
      return false;
    }

    // Update the cache with the current timestamp
    this.viewedCache.set(key, now);

    // Trigger cleanup if cache is too large
    if (this.viewedCache.size > this.maxCacheSize) {
      this.cleanup();
    }

    return true;
  }

  /**
   * Remove expired entries from the cache to prevent memory leaks.
   * Called automatically when the cache exceeds maxCacheSize.
   */
  private cleanup(): void {
    const now = Date.now();
    let removedCount = 0;

    // Remove entries older than the throttle window
    for (const [key, timestamp] of this.viewedCache.entries()) {
      if (now - timestamp > this.throttleWindowMs) {
        this.viewedCache.delete(key);
        removedCount++;
      }

      // Stop if we've reduced the cache enough
      if (this.viewedCache.size <= this.cleanupThreshold) {
        break;
      }
    }

    this.logger.debug({
      message: 'Throttle cache cleanup completed',
      removedEntries: removedCount,
      remainingEntries: this.viewedCache.size,
    });
  }

  /**
   * Get the current cache size (for monitoring/debugging).
   */
  getCacheSize(): number {
    return this.viewedCache.size;
  }

  /**
   * Clear all entries from the cache (for testing or reset).
   */
  clearCache(): void {
    this.viewedCache.clear();
    this.logger.debug({ message: 'Throttle cache cleared' });
  }

  /**
   * Check if a specific resource is currently being throttled.
   *
   * @param resourceType - The type of resource
   * @param resourceId - The ID of the resource
   * @param userId - Optional user ID
   * @returns true if the resource is currently throttled, false otherwise
   */
  isThrottled(resourceType: ResourceType, resourceId: string, userId?: string): boolean {
    const key = userId ? `${resourceType}:${resourceId}:${userId}` : `${resourceType}:${resourceId}`;

    const now = Date.now();
    const lastLogged = this.viewedCache.get(key);

    return !!(lastLogged && now - lastLogged < this.throttleWindowMs);
  }
}

/**
 * Symbol for the EventThrottleService interface, used for dependency injection.
 */
export const IEventThrottleService = Symbol('IEventThrottleService');
