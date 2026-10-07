/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GuardrailPolicyRevision extends BaseTenantDataModel {
  public aiModelId: string;
  public policyKey: string;
  public value: JsonValue;
  public valueHash: string;
  public actorId: string;
  public reason: string;
  public restoredFromRevisionId: string | null;
  public at: Date;

  constructor(data: GuardrailPolicyRevision & BaseTenantDataModel) {
    super(data);
    this.aiModelId = data.aiModelId;
    this.policyKey = data.policyKey;
    this.value = data.value;
    this.valueHash = data.valueHash;
    this.actorId = data.actorId;
    this.reason = data.reason;
    this.restoredFromRevisionId = data.restoredFromRevisionId;
    this.at = data.at;
  }
}
