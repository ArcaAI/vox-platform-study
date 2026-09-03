import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Injectable } from '@nestjs/common';
import { IActiveUserContext, IBaseService, IServiceAccountPrincipal } from '../interfaces';
import { BaseEntity, ResourceType, SysEvent, SysEventType, SendContactMessageEvent, generateId } from '@arcaai/domains';
import { applyChangesToEntity, ChangeFieldHandlers } from './applyChangesToEntity';
import { assertExpectedVersion } from './assertExpectedVersion';
import { UserSession } from '../services';

/**
 * Reserved SYSTEM tenant that owns platform-wide/tenant-less resources.
 * Mirrors `SYSTEM_TENANT_ID` in `tenant.service.ts` and the pre-CLS fallback
 * already used by `AuditLogService` for LOGIN/IMPERSONATION events;
 * duplicated here as a literal (established convention — see
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
   * `payload.tenantId`. Tenant attribution is a security boundary (HIPAA
   * letting an upstream caller override it would let a
   * foreign-tenant payload be misattributed to the active tenant context (or
   * vice versa).
   *
   * When CLS carries no tenant at all (a SUPER_ADMIN authenticates
   * with an empty `tenantId` and stays unscoped until they elevate to a
   * working tenant, or a truly tenant-less resource is mutated), falling back
   * to `null` made `AuditLogProcessor`'s fail-closed guard reject the job
   * outright. Falls back to the reserved SYSTEM tenant instead — the same
   * convention `AuditLogService` already uses for pre-CLS LOGIN/IMPERSONATION
   * events — so platform-level events are attributed to SYSTEM rather than
   * crashing the queue. Still CLS-only: the caller-supplied `payload.tenantId`
   * is never consulted, so the anti-spoofing invariant above is unchanged.
   *
   * Impersonation provenance: when the CLS user carries an
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
      // ENVELOPE IDENTITY. This emits a plain object, never a `SysEvent`
      // instance, so the constructor's `id = props.id || generateId()` never
      // ran and every broadcast event carried `id: undefined`. The webhook
      // fan-out derives its BullMQ job id from it
      // (`hook:<webhookId>:<envelopeId>`), so that id collapsed to the constant
      // `hook:<webhookId>:undefined` — BullMQ deduplicated it, and a webhook
      // therefore delivered its FIRST event and then silently nothing, ever.
      // `sourceEnvelopeId` on the delivery log was unset for the same reason,
      // leaving deliveries untraceable to the event that caused them. Stays
      // ahead of `...data` so an explicit caller-supplied id still wins.
      id: generateId(),
      // The event type was ONLY the emit channel name, never a field on the
      // envelope, so `SysEvent.type` was undefined for every consumer that reads
      // the payload rather than the channel. The webhook body carries it as
      // `eventType`, and `JSON.stringify` drops undefined — subscribers received
      // a notification that never said WHAT happened.
      type,
      // EXACTLY ONE actor. A service-account request carries a
      // machine principal on its own CLS key; stamping the bound human's id
      // (which is what this line did unconditionally before) attributed a
      // machine's admin action to a person, with no record of which credential
      // performed it. When a machine principal is present the human column is
      // left UNSET rather than filled with a plausible-looking id: a wrong
      // attribution is undetectable to a reviewer, a missing one is not.
      ...(this.requestServiceAccount
        ? { responsibleServiceAccountId: this.requestServiceAccount.id }
        : { responsibleEntityId: this.requestUser?.id }),
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
    // F-01 — ORDER IS LOAD-BEARING. The DTO changes are applied FIRST, and the
    // `updatedBy` stamp only follows if something was actually staged.
    //
    // `updatedBy` routes through `BaseEntity.setProperty`, which records a
    // change on any genuine value transition. Stamping BEFORE applying the DTO
    // therefore manufactured a change out of thin air whenever the stamp was a
    // real transition (NULL -> userId on a freshly created row, or a change of
    // editor). A semantically empty request then sailed past every caller's
    // `if (!entity.hasChanges) throw new ArgumentInvalidException('No changes
    // to write to.')` guard and committed: `_version` bumped, `updatedAt`
    // rewritten, and a ResourceUpdated sys-event/audit row emitted for a
    // request that changed nothing. Worse, the SAME request returned 400 on the
    // second attempt (by then the stamp was value-identical), so the documented
    // contract was history-dependent — and every no-op write silently
    // invalidated other clients' ETags, producing spurious 412s and audit noise
    // in a healthcare compliance trail.
    //
    // Applying first makes emptiness a property of the request alone. A genuine
    // update still stamps `updatedBy` exactly as before; `entity.hasChanges` is
    // also true when the CALLER staged changes on the entity before invoking
    // this method, so those keep their stamp too.
    await applyChangesToEntity(entity, changes, customHandlers);

    if (entity.hasChanges && this.requestUser) {
      entity.updatedBy = this.requestUser.id;
    }

    return entity.changes;
  }

  /**
   * Instance shim over the shared {@link assertExpectedVersion} helper, which
   * carries the full rationale. Defaults the error's model name to this
   * service's `resourceType`; pass `model` explicitly when the service mutates a
   * different model (e.g. tenant config -> GlobalSetting).
   */
  protected assertExpectedVersion(entity: BaseEntity, expectedVersion?: number | null, model?: string): void {
    assertExpectedVersion(entity, expectedVersion, model ?? String(this.resourceType));
  }

  get requestUser(): UserSession | null {
    return this.clsService.get('user');
  }

  /**
   * The MACHINE principal for this request, or null for a human one
   * Read from its own CLS key — never from `user` — so no existing
   * `requestUser` consumer can accidentally observe a service account as a
   * person.
   */
  get requestServiceAccount(): IServiceAccountPrincipal | null {
    return this.clsService.get('serviceAccount') ?? null;
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
