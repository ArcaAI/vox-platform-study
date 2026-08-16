/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ConsentGrant extends BaseTenantDataModel {
  public externalPatientId: string;
  public purpose: Enums.ConsentPurpose;
  public scope: JsonValue | null;
  public grantedAt: Date;
  public grantedBy: string;
  public grantMethod: Enums.ConsentGrantMethod;
  public evidenceRef: string | null;
  public expiresAt: Date | null;
  public revokedAt: Date | null;
  public revokedBy: string | null;
  public revocationReason: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: ConsentGrant & BaseTenantDataModel) {
    super(data);
    this.externalPatientId = data.externalPatientId;
    this.purpose = data.purpose;
    this.scope = data.scope;
    this.grantedAt = data.grantedAt;
    this.grantedBy = data.grantedBy;
    this.grantMethod = data.grantMethod;
    this.evidenceRef = data.evidenceRef;
    this.expiresAt = data.expiresAt;
    this.revokedAt = data.revokedAt;
    this.revokedBy = data.revokedBy;
    this.revocationReason = data.revocationReason;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
