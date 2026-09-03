import { EntityId, SysEvent } from '../common';
import { AuditAction, ResourceType } from '../enums';
import { JsonValue } from '../interfaces';

export interface UserActivityJob {
  userId: EntityId;
  date: Date;
}

export interface SendEmailJob {
  fromEmailAddressId: EntityId;
  recipientEmailAddressId: string;
  marketingCampaignId?: EntityId;
  createdByUserId?: EntityId;
  subject: string;
  body: string;
}

export interface SendSmsJob {
  fromPhoneNumberId: EntityId;
  recipientPhoneNumberId: string;
  marketingCampaignId?: EntityId;
  createdByUserId?: EntityId;
  message: string;
}

export interface SysEventJob {
  id: EntityId;
  data: SysEvent;
}

export interface AuditLogJob {
  action: AuditAction;
  responsibleUserId: EntityId;
  /** the MACHINE actor; mutually exclusive with `responsibleUserId`. */
  responsibleServiceAccountId?: EntityId;
  responsibleIp?: string;
  resourceId?: EntityId;
  resourceType: ResourceType;
  data?: JsonValue;
  previousData?: JsonValue;
  metadata?: JsonValue;
  /** Correlation ID for distributed tracing across the request lifecycle */
  correlationId?: string;
  /** Tenant ID for multi-tenancy audit log isolation */
  tenantId?: EntityId;
}

export interface WebCrawlerJob {
  url: string;
}
