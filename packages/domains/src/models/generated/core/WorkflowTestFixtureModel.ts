/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WorkflowTestFixture extends BaseTenantDataModel {
  public name: string;
  public description: string | null;
  public paletteId: string | null;
  public workflowDefinitionId: string | null;
  // Plaintext `input` column DROPPED; persistence is ciphertext-only. The
  // entity keeps `input` as a transient field repopulated by decrypt-on-read.
  // Vault-Transit ciphertext column + shared key version.
  public encryptedInput: Uint8Array | null;
  public keyVersion: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: WorkflowTestFixture & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.paletteId = data.paletteId;
    this.workflowDefinitionId = data.workflowDefinitionId;
    this.encryptedInput = data.encryptedInput;
    this.keyVersion = data.keyVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
