import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { Injectable } from '@nestjs/common';
import { IActiveUserContext, IBaseService } from '../interfaces';
import { BaseEntity, ResourceType, SysEvent, SysEventType, SendContactMessageEvent } from '@arcaai/domains';
import { applyChangesToEntity, ChangeFieldHandlers } from './applyChangesToEntity';
import { UserSession } from '../services';

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
     * Context fields (responsibleEntityId, responsibleIp, correlationId, tenantId)
     * are automatically populated from the CLS request context. However, if the caller
     * explicitly provides any of these fields in the `data` parameter, the explicit
     * values take precedence over the CLS context.
     *
     * This is critical for background/system processes where CLS context may not
     * contain the original user (e.g., STT internal service, cron jobs).
     *
     * @param type - The system event type
     * @param data - Event payload. Explicit responsibleEntityId overrides CLS context.
     */
    broadcastSysEvent(type: SysEventType, data: Partial<SysEvent> | Partial<SendContactMessageEvent>): void {
        this.eventEmitter.emit(type, {
            // CLS context defaults (can be overridden by explicit values in data)
            responsibleEntityId: this.requestUser?.id,
            responsibleIp: this.requestIp,
            resourceType: this.resourceType,
            correlationId: this.correlationId,
            tenantId: this.tenantId,
            // Caller data spread LAST so explicit values override CLS defaults
            ...data,
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
