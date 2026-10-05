/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ComposedPromptRecord extends BaseTenantDataModel {
  public consultationId: string | null;
  public agentSlug: string | null;
  public phase: string;
  public provider: string;
  public locality: string;
  public systemCiphertext: Uint8Array;
  public userCiphertext: Uint8Array;
  public keyVersion: number | null;
  public sha256: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: ComposedPromptRecord & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.agentSlug = data.agentSlug;
    this.phase = data.phase;
    this.provider = data.provider;
    this.locality = data.locality;
    this.systemCiphertext = data.systemCiphertext;
    this.userCiphertext = data.userCiphertext;
    this.keyVersion = data.keyVersion;
    this.sha256 = data.sha256;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
