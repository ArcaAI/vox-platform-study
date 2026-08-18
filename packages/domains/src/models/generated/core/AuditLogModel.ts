/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AuditLog {
  public metaData: JsonValue | null;
  public version: number;
  public id: string;
  public tenantId: string;
  public responsibleUserId: string | null;
  public responsibleServiceAccountId: string | null;
  public responsibleIp: string | null;
  public resourceType: Enums.ResourceType;
  public resourceId: string | null;
  public resourceDatabase: string | null;
  public correlationId: string | null;
  public causationId: string | null;
  public action: Enums.AuditAction;
  public eventType: string | null;
  public success: boolean | null;
  public data: JsonValue;
  public previousData: JsonValue;
  public metadata: JsonValue | null;
  // Envelope-encryption columns (nullable; NULL on legacy
  // plaintext rows). Prisma maps Bytes → Uint8Array.
  public encryptedData: Uint8Array | null;
  public encryptedPreviousData: Uint8Array | null;
  public dekWrapped: string | null;
  public dekKeyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public createdBy: string | null;
  public updatedBy: string | null;
  public createdAt: Date;
  public updatedAt: Date;

  constructor(data: AuditLog) {
    this.metaData = data.metaData;
    this.version = data.version;
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.responsibleUserId = data.responsibleUserId;
    this.responsibleServiceAccountId = data.responsibleServiceAccountId;
    this.responsibleIp = data.responsibleIp;
    this.resourceType = data.resourceType;
    this.resourceId = data.resourceId;
    this.resourceDatabase = data.resourceDatabase;
    this.correlationId = data.correlationId;
    this.causationId = data.causationId;
    this.action = data.action;
    this.eventType = data.eventType;
    this.success = data.success;
    this.data = data.data;
    this.previousData = data.previousData;
    this.metadata = data.metadata;
    this.encryptedData = data.encryptedData;
    this.encryptedPreviousData = data.encryptedPreviousData;
    this.dekWrapped = data.dekWrapped;
    this.dekKeyVersion = data.dekKeyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.createdBy = data.createdBy;
    this.updatedBy = data.updatedBy;
    this.createdAt = data.createdAt;
    this.updatedAt = data.updatedAt;
  }
}
