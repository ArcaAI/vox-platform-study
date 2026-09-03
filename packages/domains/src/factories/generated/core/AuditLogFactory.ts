/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AuditLogEntity, IAuditLogEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateAuditLogProps extends BaseEntityFactoryCreateProps {
  responsibleUserId?: IAuditLogEntity['responsibleUserId'];
  responsibleServiceAccountId?: IAuditLogEntity['responsibleServiceAccountId'];
  responsibleIp?: IAuditLogEntity['responsibleIp'];
  resourceType: IAuditLogEntity['resourceType'];
  resourceId?: IAuditLogEntity['resourceId'];
  resourceDatabase?: IAuditLogEntity['resourceDatabase'];
  correlationId?: IAuditLogEntity['correlationId'];
  causationId?: IAuditLogEntity['causationId'];
  action: IAuditLogEntity['action'];
  eventType?: IAuditLogEntity['eventType'];
  success?: IAuditLogEntity['success'];
  data: IAuditLogEntity['data'];
  previousData: IAuditLogEntity['previousData'];
  metadata?: IAuditLogEntity['metadata'];
  tenantId: IAuditLogEntity['tenantId'];
  Tenant?: IAuditLogEntity['Tenant'];

  createdAt?: IAuditLogEntity['createdAt'];
  updatedAt?: IAuditLogEntity['updatedAt'];
  createdBy?: IAuditLogEntity['createdBy'];
  updatedBy?: IAuditLogEntity['updatedBy'];
}

export class AuditLogFactory {
  static CreateAuditLog(props: CreateAuditLogProps): AuditLogEntity {
    const id = generateId();
    const now = new Date();

    return new AuditLogEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      // the machine path leaves the human column NULL rather than
      // stamping the empty-string placeholder every other row uses, so a
      // service-account row is distinguishable from "a human whose id we
      // failed to resolve". The `?? ''` default is preserved verbatim for
      // every existing (human) caller.
      responsibleUserId: props.responsibleUserId ?? (props.responsibleServiceAccountId ? null : ''),
      responsibleServiceAccountId: props.responsibleServiceAccountId ?? null,
      responsibleIp: props.responsibleIp ?? '',
      resourceType: props.resourceType,
      resourceId: props.resourceId ?? '',
      resourceDatabase: props.resourceDatabase ?? '',
      correlationId: props.correlationId ?? '',
      causationId: props.causationId ?? '',
      action: props.action,
      eventType: props.eventType ?? null,
      success: props.success ?? null,
      data: props.data,
      previousData: props.previousData,
      metadata: props.metadata ?? null,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
