/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for the ordered session-trajectory step stream (TASK-510
 * Phase 2A). Extends `BaseTenantDataModel` (id / tenantId / _version /
 * _metadata / createdBy / updatedBy / createdAt / updatedAt). Deliberately has
 * NO `resourceStatus*` columns — the table is high-volume ops telemetry with
 * HARD RETENTION (pruned by a nightly job), not soft-deleted, so it is listed
 * in MODELS_WITHOUT_SOFT_DELETE. `version` is DB-owned and stripped from the
 * create payload by the mapper (only `updateWithVersion` writes it).
 */
export class AgentTrajectoryStep extends BaseTenantDataModel {
  public consultationId: string | null;
  public sessionKind: Enums.AgentSessionKind;
  public sessionId: string;
  public runId: string;
  public seq: number;
  public stepType: Enums.AgentStepType;
  public name: string;
  public status: Enums.AgentStepStatus;
  public startedAt: Date;
  public endedAt: Date | null;
  public durationMs: number | null;
  // Stats-first / payload-by-reference: `stats` holds the AD-1 GenerationStats
  // for LLM_CALL steps; `payloadRef` is a claim-check ref / encrypted pointer
  // only — never plaintext clinical content.
  public stats: JsonValue | null;
  public payloadRef: JsonValue | null;
  public errorCode: string | null;
  public correlationId: string | null;

  constructor(data: AgentTrajectoryStep & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.sessionKind = data.sessionKind;
    this.sessionId = data.sessionId;
    this.runId = data.runId;
    this.seq = data.seq;
    this.stepType = data.stepType;
    this.name = data.name;
    this.status = data.status;
    this.startedAt = data.startedAt;
    this.endedAt = data.endedAt;
    this.durationMs = data.durationMs;
    this.stats = data.stats;
    this.payloadRef = data.payloadRef;
    this.errorCode = data.errorCode;
    this.correlationId = data.correlationId;
  }
}
