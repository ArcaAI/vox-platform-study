import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Injectable } from '@nestjs/common';
import { IActiveUserContext, IBaseService } from '../interfaces';
import { BaseEntity, ResourceType, SysEvent, SysEventType, SendContactMessageEvent } from '@arcaai/domains';
import { applyChangesToEntity, ChangeFieldHandlers } from './applyChangesToEntity';
import { UserSession } from '../services';

/**
 * Reserved SYSTEM tenant that owns platform-wide/tenant-less resources.
 * Mirrors `SYSTEM_TENANT_ID` in `tenant.service.ts` and the pre-CLS fallback
 * already used by `AuditLogService` for LOGIN/IMPERSONATION events (TASK-305
 * A.8); duplicated here as a literal (established convention — see
 * `tenant.service.ts`) so this common module carries no dependency on the
 * database package.
 */
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Base service class providing common functionality for all services.
 *
 * For authorization, use the new PolicyEngine and AuthorizationGuard
 * from packages/applications/src/authorization/
 */
@Injectable()
export abstract class BaseService implements IBaseService {
  constructor(
    protected readonly eventEmitter: EventEmitter2,
    protected readonly clsService: ClsService<IActiveUserContext>,
    protected readonly resourceType: ResourceType,
  ) {}

  /**
   * Broadcast a system event for audit logging, user activity tracking, and webhooks.
   *
   * Context fields (`responsibleEntityId`, `responsibleIp`, `correlationId`)
   * default from the CLS request context but MAY be overridden by an explicit
   * value in the `data` payload. This is critical for background/system
   * processes where the CLS context may not contain the original user
   * (e.g., STT internal service, cron jobs).
   *
   * `tenantId` is the one exception: it is ALWAYS sourced from the CLS
   * request context and CANNOT be overridden by a caller-supplied
   * `payload.tenantId`. Tenant attribution is a security boundary
   * (HIPAA §164.312(a)(1) — TASK-306 P3.1 / AC-10, closes audit M-5);
   * letting an upstream caller override it would let a foreign-tenant
   * payload be misattributed to the active tenant context (or vice versa).
   *
   * TASK-503 — when CLS carries no tenant at all (a GLOBAL_ADMIN authenticates
   * with an empty `tenantId` and stays unscoped until they elevate to a
   * working tenant, or a truly tenant-less resource is mutated), falling back
   * to `null` made `AuditLogProcessor`'s fail-closed guard reject the job
   * outright. Falls back to the reserved SYSTEM tenant instead — the same
   * convention `AuditLogService` already uses for pre-CLS LOGIN/IMPERSONATION
   * events — so platform-level events are attributed to SYSTEM rather than
   * crashing the queue. Still CLS-only: the caller-supplied `payload.tenantId`
   * is never consulted, so the anti-spoofing invariant above is unchanged.
   *
   * TASK-401 — impersonation provenance: when the CLS user carries an
   * `impersonatedBy` claim (a write performed under an impersonated session),
   * the true actor is threaded into the event's `metaData` so the persisted
   * audit row records BOTH the subject (`responsibleUserId` = the impersonated
   * user) and the impersonator. Caller-supplied `metaData` keys are preserved;
   * like `tenantId`, the `impersonatedBy` attribution cannot be overridden by
   * the payload.
   *
   * @param type - The system event type
   * @param data - Event payload. Explicit responsibleEntityId/Ip/correlationId
   *               override CLS context; an explicit `tenantId` is IGNORED.
   */
  broadcastSysEvent(type: SysEventType, data: Partial<SysEvent> | Partial<SendContactMessageEvent>): void {
    const impersonatedBy = this.requestUser?.impersonatedBy;
    this.eventEmitter.emit(type, {
      responsibleEntityId: this.requestUser?.id,
      responsibleIp: this.requestIp,
      resourceType: this.resourceType,
      correlationId: this.correlationId,
      ...data,
      tenantId: this.tenantId ?? SYSTEM_TENANT_ID,
      ...(impersonatedBy
        ? {
            metaData: {
              ...(typeof data.metaData === 'object' && data.metaData !== null && !Array.isArray(data.metaData) ? data.metaData : {}),
              impersonatedBy,
            },
          }
        : {}),
    });
  }

  async updateEntity<T extends BaseEntity, K extends object>(
    entity: T,
    changes: K,
    customHandlers?: ChangeFieldHandlers<T, K>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<Record<string, any>> {
    if (this.requestUser) {
      entity.updatedBy = this.requestUser?.id;
    }
    await applyChangesToEntity(entity, changes, customHandlers);

    return entity.changes;
  }

  get requestUser(): UserSession | null {
    return this.clsService.get('user');
  }

  get requestUserId(): string | null {
    return this.clsService.get('user')?.id;
  }

  get requestUserName(): string | null {
    return `${this.clsService.get('user')?.firstName} ${this.clsService.get('user')?.lastName}`;
  }

  get requestUserEmail(): string | null {
    return this.clsService.get('user')?.email;
  }

  get tenantId(): string | null {
    return this.clsService.get('tenantId') || null;
  }

  get tenantCode(): string | null {
    return this.clsService.get('tenantCode') || null;
  }

  get correlationId(): string | null {
    return this.clsService.get('correlationId');
  }

  get requestIp(): string | null {
    return this.clsService.get('requestIp');
  }
}
