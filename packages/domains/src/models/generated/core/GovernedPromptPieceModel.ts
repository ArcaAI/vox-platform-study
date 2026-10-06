/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GovernedPromptPiece extends BaseTenantDataModel {
  public digest: string;
  public kind: Enums.GovernedPromptPieceKind;
  public sourceType: Enums.GovernedPromptSourceType;
  public sourceId: string | null;
  public sourceKey: string | null;
  public policyVersion: string;
  public verdict: Enums.GovernedPromptVerdict;
  public findings: JsonValue | null;
  public textChars: number;
  public screenedAt: Date;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: GovernedPromptPiece & BaseTenantDataModel) {
    super(data);
    this.digest = data.digest;
    this.kind = data.kind;
    this.sourceType = data.sourceType;
    this.sourceId = data.sourceId;
    this.sourceKey = data.sourceKey;
    this.policyVersion = data.policyVersion;
    this.verdict = data.verdict;
    this.findings = data.findings;
    this.textChars = data.textChars;
    this.screenedAt = data.screenedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
