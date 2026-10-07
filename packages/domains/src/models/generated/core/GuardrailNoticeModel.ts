/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GuardrailNotice extends BaseTenantDataModel {
  public consultationId: string | null;
  public runId: string | null;
  public nodeId: string | null;
  public type: Enums.GuardrailNoticeType;
  public direction: Enums.GuardrailDirection;
  public action: string;
  public checks: JsonValue;
  public itemIds: string[];
  public messageKey: string;
  public severity: string;
  public requiresAcknowledgement: boolean;
  public resumable: boolean;
  public policyVersion: string;
  public dedupeKey: string;
  public status: Enums.GuardrailNoticeStatus;
  public acknowledgedBy: string | null;
  public acknowledgedAt: Date | null;
  public acknowledgedVia: string | null;
  public resolution: string | null;
  public resolvedBy: string | null;
  public resolvedAt: Date | null;

  constructor(data: GuardrailNotice & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.runId = data.runId;
    this.nodeId = data.nodeId;
    this.type = data.type;
    this.direction = data.direction;
    this.action = data.action;
    this.checks = data.checks;
    this.itemIds = data.itemIds;
    this.messageKey = data.messageKey;
    this.severity = data.severity;
    this.requiresAcknowledgement = data.requiresAcknowledgement;
    this.resumable = data.resumable;
    this.policyVersion = data.policyVersion;
    this.dedupeKey = data.dedupeKey;
    this.status = data.status;
    this.acknowledgedBy = data.acknowledgedBy;
    this.acknowledgedAt = data.acknowledgedAt;
    this.acknowledgedVia = data.acknowledgedVia;
    this.resolution = data.resolution;
    this.resolvedBy = data.resolvedBy;
    this.resolvedAt = data.resolvedAt;
  }
}
