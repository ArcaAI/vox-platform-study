import { EntityId, DomainEvent, BaseDomainEventProps } from '../../../common';
import { AuditAction, ResourceType } from '../../../enums';
import { JsonValue } from '../../../interfaces';

export interface ResourceEventProps {
    resourceType: ResourceType;
    action: AuditAction;
    responsibleEntityId: EntityId;
    responsibleEntityType: ResourceType;
    responsibleIp?: string;
    data: JsonValue;
    previousData: JsonValue | null;
    metadata: JsonValue | null;
    domain: string;
}

export class ResourceEvent extends DomainEvent<ResourceEventProps> {
    constructor(props: BaseDomainEventProps<ResourceEventProps>) {
        super(props);
    }
}
