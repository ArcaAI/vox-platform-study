import { Injectable, Logger, Inject, Optional } from '@nestjs/common';
import { CoreDatabaseService } from '@arcaai/domains';
import { IRedisCacheService } from '../baseServices/redis';

/**
 * Authorization audit entry structure
 */
export interface AuthorizationAuditEntry {
  /** User ID who made the request */
  userId: string;
  /** Action attempted (e.g., 'read', 'create', 'update', 'delete') */
  action: string;
  /** Subject/resource type (e.g., 'User', 'Consultation') */
  subject: string;
  /** Specific resource ID if applicable */
  resourceId?: string;
  /** Whether the action was allowed */
  allowed: boolean;
  /** API endpoint path */
  endpoint: string;
  /** HTTP method */
  method: string;
  /** Reason for denial (if not allowed) */
  reason?: string;
  /** Timestamp of the decision */
  timestamp: Date;
  /** Tenant ID context */
  tenantId?: string;
  /** Client IP address */
  ipAddress?: string;
  /** User agent string */
  userAgent?: string;
}

/**
 * Options for querying audit history
 */
export interface AuditHistoryOptions {
  /** Maximum number of entries to return */
  limit?: number;
  /** Return entries since this date */
  since?: Date;
  /** Filter by action */
  action?: string;
  /** Filter by subject */
  subject?: string;
  /** Filter by allowed/denied */
  allowed?: boolean;
}

/**
 * Interface for Authorization Audit Service
 */
export interface IAuthorizationAuditService {
  /**
   * Log an authorization decision
   */
  logAuthorizationDecision(entry: Omit<AuthorizationAuditEntry, 'timestamp'>): Promise<void>;

  /**
   * Get authorization history for a user
   */
  getAuthorizationHistory(userId: string, options?: AuditHistoryOptions): Promise<AuthorizationAuditEntry[]>;

  /**
   * Get recent denied access attempts
   */
  getRecentDenials(options?: AuditHistoryOptions): Promise<AuthorizationAuditEntry[]>;
}

export const IAuthorizationAuditService = Symbol('IAuthorizationAuditService');

/**
 * Authorization Audit Service
 *
 * Logs all authorization decisions for compliance and security monitoring.
 *
 * Features:
 * - Async logging to database (non-blocking)
 * - Real-time publishing to Redis for monitoring
 * - Query history by user, action, subject
 * - Track denied access attempts
 *
 * @example
 * ```typescript
 * // In AuthorizationGuard
 * await this.auditService.logAuthorizationDecision({
 *   userId: user.id,
 *   action: 'read',
 *   subject: 'User',
 *   allowed: true,
 *   endpoint: '/api/users',
 *   method: 'GET',
 * });
 * ```
 */
@Injectable()
export class AuthorizationAuditService implements IAuthorizationAuditService {
  private readonly logger = new Logger(AuthorizationAuditService.name);
  private readonly REDIS_CHANNEL = 'authorization:audit';
  private readonly REDIS_DENIALS_KEY = 'authorization:recent-denials';
  private readonly DENIALS_TTL = 3600; // 1 hour

  constructor(
    private readonly databaseService: CoreDatabaseService,
    @Optional() @Inject(IRedisCacheService) private readonly cache?: IRedisCacheService,
  ) {
    this.logger.log('AuthorizationAuditService initialized');
  }

  /**
   * Log an authorization decision
   *
   * This method is designed to be non-blocking - it logs asynchronously
   * and doesn't throw errors to avoid impacting the main request flow.
   */
  async logAuthorizationDecision(entry: Omit<AuthorizationAuditEntry, 'timestamp'>): Promise<void> {
    const auditEntry: AuthorizationAuditEntry = {
      ...entry,
      timestamp: new Date(),
    };

    // Log to database asynchronously (fire and forget)
    this.logToDatabase(auditEntry).catch((err) => {
      this.logger.error('Failed to log authorization decision to database', err);
    });

    // Publish to Redis for real-time monitoring
    if (this.cache?.isConnected()) {
      this.publishToRedis(auditEntry).catch((err) => {
        this.logger.warn('Failed to publish authorization decision to Redis', err);
      });

      // Track denials separately for quick access
      if (!entry.allowed) {
        this.trackDenial(auditEntry).catch((err) => {
          this.logger.warn('Failed to track denial in Redis', err);
        });
      }
    }

    // Log to application logger for immediate visibility
    if (entry.allowed) {
      this.logger.debug(`AUTH_ALLOWED: ${entry.userId} ${entry.action}:${entry.subject} at ${entry.endpoint}`);
    } else {
      this.logger.warn(
        `AUTH_DENIED: ${entry.userId} ${entry.action}:${entry.subject} at ${entry.endpoint}` + (entry.reason ? ` - ${entry.reason}` : ''),
      );
    }
  }

  /**
   * Log to database
   */
  private async logToDatabase(entry: AuthorizationAuditEntry): Promise<void> {
    const prisma = this.databaseService.client;

    // Check if AuditLog model exists (it might not be migrated yet)
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).auditLog?.create({
        data: {
          eventType: 'AUTHORIZATION',
          responsibleUserId: entry.userId,
          tenantId: entry.tenantId,
          action: entry.action.toUpperCase(), // Ensure action matches AuditAction enum
          resourceType: entry.subject,
          resourceId: entry.resourceId,
          success: entry.allowed,
          data: {}, // Required field - store empty object for authorization logs
          previousData: {}, // Required field - store empty object for authorization logs
          metadata: {
            endpoint: entry.endpoint,
            method: entry.method,
            reason: entry.reason,
            ipAddress: entry.ipAddress,
            userAgent: entry.userAgent,
          },
          createdAt: entry.timestamp,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      // AuditLog model might not exist yet
      this.logger.debug('AuditLog model not available, skipping database logging');
    }
  }

  /**
   * Publish to Redis for real-time monitoring
   */
  private async publishToRedis(entry: AuthorizationAuditEntry): Promise<void> {
    if (!this.cache) return;

    await this.cache.publish(this.REDIS_CHANNEL, JSON.stringify(entry));
  }

  /**
   * Track denial in Redis for quick access
   */
  private async trackDenial(entry: AuthorizationAuditEntry): Promise<void> {
    if (!this.cache) return;

    // Store in a sorted set with timestamp as score
    // This allows efficient retrieval of recent denials
    const key = `${this.REDIS_DENIALS_KEY}:${entry.userId}`;
    const value = JSON.stringify({
      action: entry.action,
      subject: entry.subject,
      endpoint: entry.endpoint,
      reason: entry.reason,
      timestamp: entry.timestamp.toISOString(),
    });

    // Use setex to store with TTL
    await this.cache.setex(`${key}:${entry.timestamp.getTime()}`, this.DENIALS_TTL, value);
  }

  /**
   * Get authorization history for a user
   * Uses optimized index: AuditLog_event_user_time_idx (eventType, responsibleUserId, createdAt)
   */
  async getAuthorizationHistory(userId: string, options: AuditHistoryOptions = {}): Promise<AuthorizationAuditEntry[]> {
    const prisma = this.databaseService.client;
    const { limit = 100, since, action, subject, allowed } = options;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logs = await (prisma as any).auditLog?.findMany({
        where: {
          responsibleUserId: userId,
          eventType: 'AUTHORIZATION',
          ...(since && { createdAt: { gte: since } }),
          ...(action && { action: action.toUpperCase() }),
          ...(subject && { resourceType: subject }),
          ...(allowed !== undefined && { success: allowed }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      if (!logs) return [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return logs.map((log: any) => ({
        userId: log.responsibleUserId,
        action: log.action,
        subject: log.resourceType,
        resourceId: log.resourceId,
        allowed: log.success,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        endpoint: (log.metadata as any)?.endpoint,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: (log.metadata as any)?.method,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: (log.metadata as any)?.reason,
        timestamp: log.createdAt,
        tenantId: log.tenantId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ipAddress: (log.metadata as any)?.ipAddress,
      }));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      this.logger.debug('AuditLog model not available');
      return [];
    }
  }

  /**
   * Get recent denied access attempts
   */
  async getRecentDenials(options: AuditHistoryOptions = {}): Promise<AuthorizationAuditEntry[]> {
    const { limit = 50, since } = options;

    // Try to get from database
    const prisma = this.databaseService.client;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const logs = await (prisma as any).auditLog?.findMany({
        where: {
          eventType: 'AUTHORIZATION',
          success: false,
          ...(since && { createdAt: { gte: since } }),
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      if (!logs) return [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return logs.map((log: any) => ({
        userId: log.userId,
        action: log.action,
        subject: log.resourceType,
        resourceId: log.resourceId,
        allowed: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        endpoint: (log.metadata as any)?.endpoint,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        method: (log.metadata as any)?.method,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reason: (log.metadata as any)?.reason,
        timestamp: log.createdAt,
        tenantId: log.tenantId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ipAddress: (log.metadata as any)?.ipAddress,
      }));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      this.logger.debug('AuditLog model not available');
      return [];
    }
  }

  /**
   * Get denial count for a user in the last hour
   * Useful for detecting potential security issues
   */
  async getDenialCount(userId: string, windowMinutes: number = 60): Promise<number> {
    const since = new Date(Date.now() - windowMinutes * 60 * 1000);
    const denials = await this.getAuthorizationHistory(userId, {
      since,
      allowed: false,
    });
    return denials.length;
  }
}
