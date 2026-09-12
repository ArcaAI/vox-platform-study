/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiUsageEvent extends BaseTenantDataModel {
  public idempotencyKey: string;
  public occurredAt: Date;
  public recordedAt: Date;
  public capability: Enums.AiCapability;
  public operation: string;
  public provider: string;
  public connectionId: string | null;
  public model: string | null;
  public deployment: Enums.AiDeploymentKind;
  public unit: Enums.AiUsageUnit;
  public quantity: Decimal;
  public consultationId: string | null;
  public doctorId: string | null;
  public departmentId: string | null;
  public requestId: string | null;
  public sessionId: string | null;
  public unitPriceMicros: bigint | null;
  public priceBookVersion: string | null;
  public costMicros: bigint | null;
  public costBasis: Enums.AiCostBasis;
  public attributesJson: JsonValue | null;

  constructor(data: AiUsageEvent & BaseTenantDataModel) {
    super(data);
    this.idempotencyKey = data.idempotencyKey;
    this.occurredAt = data.occurredAt;
    this.recordedAt = data.recordedAt;
    this.capability = data.capability;
    this.operation = data.operation;
    this.provider = data.provider;
    this.connectionId = data.connectionId;
    this.model = data.model;
    this.deployment = data.deployment;
    this.unit = data.unit;
    this.quantity = data.quantity;
    this.consultationId = data.consultationId;
    this.doctorId = data.doctorId;
    this.departmentId = data.departmentId;
    this.requestId = data.requestId;
    this.sessionId = data.sessionId;
    this.unitPriceMicros = data.unitPriceMicros;
    this.priceBookVersion = data.priceBookVersion;
    this.costMicros = data.costMicros;
    this.costBasis = data.costBasis;
    this.attributesJson = data.attributesJson;
  }
}
