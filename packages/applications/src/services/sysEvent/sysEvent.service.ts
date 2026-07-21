import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ISysEventService } from './ISysEventService';
import { IRedisService } from '../baseServices/redis/IRedisService';
import {
  AuditAction,
  AuditLogJob,
  SysEventJob,
  JobQueue,
  JobType,
  ResourceType,
  SendEmailJob,
  SendSmsJob,
  UserActivityJob,
  SysEventType,
  SysEvent,
  SendContactMessageEvent,
} from '@arcaai/domains';
import { JobsOptions } from 'bullmq';
import { IResourceSubscriptionService } from '../resourceSubscription';

/**
 * Default job options for audit log jobs.
 *
 * Provides retry with exponential backoff to ensure audit logs are not lost
 * due to transient Redis/database failures. After all retries are exhausted,
 * the job remains in the failed state for manual inspection via Bull Board
 * or a dead-letter queue processor.
 */
const AUDIT_LOG_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1000, // 1s → 2s → 4s
  },
  removeOnComplete: true,
  removeOnFail: false, // Keep failed jobs for inspection/DLQ processing
};

/**
 * Default job options for system event jobs.
 */
const SYS_EVENT_JOB_OPTIONS: JobsOptions = {
  attempts: 2,
  backoff: {
    type: 'exponential',
    delay: 500,
  },
  removeOnComplete: true,
  removeOnFail: false,
};

@Injectable()
export class SysEventService implements ISysEventService {
  private readonly logger: Logger = new Logger(SysEventService.name);

  constructor(
    @Inject(IRedisService) private readonly redisService: IRedisService,
    @Inject(IResourceSubscriptionService)
    private readonly resourceSubscriptionService: IResourceSubscriptionService,
  ) {}

  /**
   * Log failures from Promise.allSettled results and emit structured metrics.
   *
   * Structured log output enables Prometheus log-based metric extraction:
   * - `audit_event_queued_total` — counter of successfully queued audit events
   * - `audit_event_queue_failed_total` — counter of failed queue attempts
   *
   * @param results - The results from Promise.allSettled
   * @param eventType - The event type for logging context
   */
  private logJobQueueFailures(results: PromiseSettledResult<void>[], eventType: string): void {
    let succeeded = 0;
    let failed = 0;

    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failed++;
        this.logger.error({
          message: 'Failed to queue job',
          metric: 'audit_event_queue_failed_total',
          eventType,
          jobIndex: index,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      } else {
        succeeded++;
      }
    });

    if (succeeded > 0) {
      this.logger.debug({
        message: 'Jobs queued successfully',
        metric: 'audit_event_queued_total',
        eventType,
        count: succeeded,
      });
    }

    if (failed > 0) {
      this.logger.warn({
        message: `${failed}/${results.length} jobs failed to queue`,
        metric: 'audit_event_queue_failure_rate',
        eventType,
        failed,
        total: results.length,
        successRate: (((results.length - failed) / results.length) * 100).toFixed(1) + '%',
      });
    }
  }

  /**
   * Log a warning when an auditable event is missing the responsible user.
   * This helps catch cases where CLS context is not available (background jobs, cron, etc.)
   * and the caller forgot to explicitly pass responsibleEntityId.
   */
  private warnIfMissingResponsibleEntity(event: SysEvent, eventType: string): void {
    if (!event.responsibleEntityId && !event.disableAuditLog) {
      this.logger.warn({
        message: 'Audit event missing responsibleEntityId — audit log will have null author',
        metric: 'audit_event_missing_author',
        eventType,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        correlationId: event.correlationId,
      });
    }
  }

  /**
   * Build the standard AuditLogJob data payload from a SysEvent.
   */
  private buildAuditLogData(event: SysEvent, action: AuditAction): AuditLogJob {
    return {
      action,
      responsibleUserId: event.responsibleEntityId,
      responsibleIp: event.responsibleIp,
      resourceId: event.resourceId,
      resourceType: event.resourceType,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      data: event.data as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      previousData: event.previousData as any,
      // Carry the event's metaData (e.g. the impersonatedBy
      // provenance threaded by BaseService.broadcastSysEvent) into the queued
      // job so AuditLogProcessor persists it on the row's `metadata` column.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata: event.metaData as any,
      correlationId: event.correlationId,
      tenantId: event.tenantId,
    };
  }

  /**
   * Queue an audit log job if audit logging is not disabled for this event.
   */
  private queueAuditLogJob(jobs: Promise<void>[], event: SysEvent, action: AuditAction, jobType: JobType): void {
    if (!event.disableAuditLog) {
      jobs.push(
        this.redisService.addJob<AuditLogJob>({
          queueName: JobQueue.AuditLog,
          jobType,
          data: this.buildAuditLogData(event, action),
          options: AUDIT_LOG_JOB_OPTIONS,
        }),
      );
    }
  }

  /**
   * Queue a user activity job if the responsible entity is a User.
   */
  private queueUserActivityJob(jobs: Promise<void>[], event: SysEvent): void {
    if (event.responsibleEntityType === ResourceType.User && event.responsibleEntityId) {
      jobs.push(
        this.redisService.addJob<UserActivityJob>({
          queueName: JobQueue.UserActivity,
          jobType: JobType.UserActivity,
          data: {
            userId: event.responsibleEntityId,
            date: event.createdAt,
          },
        }),
      );
    }
  }

  /**
   * Queue a system event job for downstream processing (webhooks, subscriptions, etc.).
   */
  private queueSysEventJob(jobs: Promise<void>[], event: SysEvent, jobType: JobType): void {
    jobs.push(
      this.redisService.addJob<SysEventJob>({
        queueName: JobQueue.SysEvent,
        jobType,
        data: {
          id: event.id,
          data: event,
        },
        options: SYS_EVENT_JOB_OPTIONS,
      }),
    );
  }

  @OnEvent(SysEventType.ResourceCreated)
  async handleResourceCreatedEvent(event: SysEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event, SysEventType.ResourceCreated);
    const jobs: Promise<void>[] = [];

    this.queueAuditLogJob(jobs, event, AuditAction.CREATE, JobType.ResourceCreated);
    this.queueUserActivityJob(jobs, event);
    this.queueSysEventJob(jobs, event, JobType.ResourceCreated);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.ResourceCreated);
  }

  /**
   * Handle ResourceViewed events.
   *
   * IMPORTANT: READ operations are NOT logged to the audit log by default
   * to reduce database load and storage costs. This is a deliberate design decision
   * because READ events are high-frequency and often don't require compliance tracking.
   *
   * To log important READ operations (e.g., viewing sensitive data, compliance-required
   * access logs), set `forceAuditLog: true` when broadcasting the event:
   *
   * @example
   * ```typescript
   * this.broadcastSysEvent(SysEventType.ResourceViewed, {
   *     resourceId: entity.id,
   *     data: entity.toObject(),
   *     forceAuditLog: true, // Enable audit logging for this important READ
   * });
   * ```
   */
  @OnEvent(SysEventType.ResourceViewed)
  async handleResourceViewedEvent(event: SysEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event, SysEventType.ResourceViewed);
    const jobs: Promise<void>[] = [];

    // READ operations are NOT logged by default to reduce database load.
    // Only log if explicitly forced via forceAuditLog flag.
    if (!event.disableAuditLog && event.forceAuditLog) {
      this.queueAuditLogJob(jobs, event, AuditAction.READ, JobType.ResourceViewed);
    }

    this.queueUserActivityJob(jobs, event);
    this.queueSysEventJob(jobs, event, JobType.ResourceViewed);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.ResourceViewed);
  }

  @OnEvent(SysEventType.ResourceUpdated)
  async handleResourceUpdatedEvent(event: SysEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event, SysEventType.ResourceUpdated);
    const jobs: Promise<void>[] = [];

    this.queueAuditLogJob(jobs, event, AuditAction.UPDATE, JobType.ResourceUpdated);
    this.queueUserActivityJob(jobs, event);
    this.queueSysEventJob(jobs, event, JobType.ResourceUpdated);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.ResourceUpdated);
  }

  @OnEvent(SysEventType.ResourceDeleted)
  async handleResourceDeletedEvent(event: SysEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event, SysEventType.ResourceDeleted);
    const jobs: Promise<void>[] = [];

    this.queueAuditLogJob(jobs, event, AuditAction.DELETE, JobType.ResourceDeleted);
    this.queueUserActivityJob(jobs, event);
    this.queueSysEventJob(jobs, event, JobType.ResourceDeleted);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.ResourceDeleted);
  }

  @OnEvent(SysEventType.ResourceArchived)
  async handleResourceArchivedEvent(event: SysEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event, SysEventType.ResourceArchived);
    const jobs: Promise<void>[] = [];

    this.queueAuditLogJob(jobs, event, AuditAction.ARCHIVE, JobType.ResourceArchived);
    this.queueUserActivityJob(jobs, event);
    this.queueSysEventJob(jobs, event, JobType.ResourceArchived);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.ResourceArchived);
  }

  @OnEvent(SysEventType.SendContactMessage)
  async handleSendContactMessageEvent(event: SendContactMessageEvent): Promise<void> {
    this.warnIfMissingResponsibleEntity(event as SysEvent, SysEventType.SendContactMessage);
    const jobs: Promise<void>[] = [];

    if (event.messageType === 'email') {
      jobs.push(
        this.redisService.addJob<SendEmailJob>({
          queueName: JobQueue.SendEmail,
          jobType: JobType.SendEmail,
          data: {
            fromEmailAddressId: event.fromResourceId,
            recipientEmailAddressId: event.targetResourceId,
            subject: event.subject || '',
            body: event.message,
          },
        }),
      );
    }

    if (event.messageType === 'sms') {
      jobs.push(
        this.redisService.addJob<SendSmsJob>({
          queueName: JobQueue.SendSms,
          jobType: JobType.SendSms,
          data: {
            fromPhoneNumberId: event.fromResourceId,
            recipientPhoneNumberId: event.targetResourceId,
            message: event.message,
          },
        }),
      );
    }

    this.queueAuditLogJob(jobs, event as SysEvent, AuditAction.CREATE, JobType.ResourceCreated);
    this.queueUserActivityJob(jobs, event as SysEvent);

    const results = await Promise.allSettled(jobs);
    this.logJobQueueFailures(results, SysEventType.SendContactMessage);
  }
}
