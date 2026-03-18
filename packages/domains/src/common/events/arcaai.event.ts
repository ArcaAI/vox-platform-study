import { EntityId } from '../baseEntity';
import { ResourceType, SysEventType } from '../../enums';
import { generateId } from '../../utils';
import { JsonValue } from '../../interfaces';

export interface SysEventProps {
    id?: EntityId;
    type?: SysEventType;
    resourceId?: EntityId;
    resourceIds?: EntityId[];
    resourceType: ResourceType;
    responsibleEntityId: EntityId;
    responsibleEntityType?: ResourceType;
    responsibleIp?: string;
    metaData?: JsonValue | object;
    data?: JsonValue | object;
    tenantId?: EntityId;
    tenantCode?: string;
    previousData?: JsonValue | object;
    /** If true, audit logging is disabled for this event */
    disableAuditLog?: boolean;
    /**
     * If true, force audit logging even for READ events.
     * By default, READ events are not logged to reduce database load.
     * Use this for important READ operations that need to be audited
     * (e.g., viewing sensitive data, compliance-required access logs).
     */
    forceAuditLog?: boolean;
    /** Correlation ID for distributed tracing. Set automatically by BaseService.broadcastSysEvent(). */
    correlationId?: string;
    createdAt?: Date;
}

export class SysEvent {
    id!: EntityId;
    type!: SysEventType;
    resourceId?: EntityId;
    resourceIds?: EntityId[];
    resourceType!: ResourceType;
    responsibleEntityId!: EntityId;
    responsibleEntityType?: ResourceType;
    responsibleIp?: string;
    metaData?: JsonValue | object;
    data?: JsonValue | object;
    tenantId?: EntityId;
    tenantCode?: string;
    previousData?: JsonValue | object;
    disableAuditLog!: boolean;
    forceAuditLog!: boolean;
    correlationId?: string;
    createdAt!: Date;

    constructor(props: SysEventProps) {
        this.id = props.id || generateId();
        this.type = props.type || SysEventType.ResourceViewed;
        this.resourceId = props.resourceId;
        this.resourceIds = props.resourceIds;
        this.resourceType = props.resourceType;
        this.responsibleEntityId = props.responsibleEntityId;
        this.responsibleEntityType = props.responsibleEntityType || ResourceType.User;
        this.responsibleIp = props.responsibleIp;
        this.metaData = props.metaData;
        this.data = props.data;
        this.tenantId = props.tenantId;
        this.tenantCode = props.tenantCode;
        this.previousData = props.previousData;
        this.disableAuditLog = props.disableAuditLog || false;
        this.forceAuditLog = props.forceAuditLog || false;
        this.correlationId = props.correlationId;
        this.createdAt = props.createdAt || new Date();
    }
}

export interface ResourceCreatedEventProps extends SysEventProps {}

export class ResourceCreatedEvent extends SysEvent {
    constructor(props: ResourceCreatedEventProps) {
        super(props);
        Object.assign(this, props);
    }
}

export interface ResourceViewedEventProps extends SysEventProps {}
export class ResourceViewedEvent extends SysEvent {
    constructor(props: ResourceViewedEventProps) {
        super(props);
        Object.assign(this, props);
    }
}

export interface ResourceUpdatedEventProps extends SysEventProps {}
export class ResourceUpdatedEvent extends SysEvent {
    constructor(props: ResourceUpdatedEventProps) {
        super(props);
        Object.assign(this, props);
    }
}

export interface ResourceDeletedEventProps extends SysEventProps {}
export class ResourceDeletedEvent extends SysEvent {
    constructor(props: ResourceDeletedEventProps) {
        super(props);
        Object.assign(this, props);
    }
}

export interface SendContactMessageEventProps extends SysEventProps {
    fromResourceId: EntityId;
    targetResourceId: EntityId;
    subject?: string;
    message: string;
    messageType: string;
    createdBy?: EntityId;
}

export class SendContactMessageEvent extends SysEvent {
    fromResourceId!: EntityId;
    targetResourceId!: EntityId;
    subject?: string;
    message!: string;
    messageType!: string;
    createdBy?: EntityId;

    constructor(props: SendContactMessageEventProps) {
        super(props);
        this.fromResourceId = props.fromResourceId;
        this.targetResourceId = props.targetResourceId;
        this.subject = props.subject;
        this.message = props.message;
        this.messageType = props.messageType;
        this.createdBy = props.createdBy;
    }
}
