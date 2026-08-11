/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AgentPromotionEntity, IAgentPromotionEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateAgentPromotionProps extends Omit<BaseEntityFactoryCreateProps, 'tenantId'> {
  /**
   * Optional: DERIVED from `toTenantId` when omitted. The promotion record is
   * the target tenant's lineage, and the two can never disagree (the entity's
   * `validate()` enforces it), so a caller who supplies only `toTenantId`
   * cannot get this wrong.
   */
  tenantId?: IAgentPromotionEntity['tenantId'];
  fromTenantId: IAgentPromotionEntity['fromTenantId'];
  toTenantId: IAgentPromotionEntity['toTenantId'];
  agentVersionId: IAgentPromotionEntity['agentVersionId'];
  sourceAgentId: IAgentPromotionEntity['sourceAgentId'];
  targetAgentId: IAgentPromotionEntity['targetAgentId'];
  targetAgentVersionId?: IAgentPromotionEntity['targetAgentVersionId'];
  configSnapshot: IAgentPromotionEntity['configSnapshot'];
  checksum: IAgentPromotionEntity['checksum'];
  evalRunId?: IAgentPromotionEntity['evalRunId'];
  sourceEvalRunId?: IAgentPromotionEntity['sourceEvalRunId'];
  warnings?: IAgentPromotionEntity['warnings'];
  promotedBy?: IAgentPromotionEntity['promotedBy'];

  createdAt?: IAgentPromotionEntity['createdAt'];
  createdBy?: IAgentPromotionEntity['createdBy'];
}

export class AgentPromotionFactory {
  /**
   * One immutable, WORM promotion record (TASK-663).
   *
   * `checksum` is supplied by the caller rather than computed here so the SAME
   * canonicalisation the service uses to build the snapshot is the one
   * persisted — a second implementation here would be a second source of truth.
   * Mirrors `DepartmentAgentVersionFactory` / `ConsultationContextSchemaVersionFactory`.
   *
   * No `updatedAt`/`updatedBy`: the row is never updated (the mapper strips
   * them). A re-promotion writes a NEW row.
   */
  static CreateAgentPromotion(props: CreateAgentPromotionProps): AgentPromotionEntity {
    const id = generateId();
    const now = new Date();

    return new AgentPromotionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.createdAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      // The promotion record belongs to the TARGET tenant (see the entity header).
      tenantId: props.tenantId ?? props.toTenantId,
      fromTenantId: props.fromTenantId,
      toTenantId: props.toTenantId,
      agentVersionId: props.agentVersionId,
      sourceAgentId: props.sourceAgentId,
      targetAgentId: props.targetAgentId,
      targetAgentVersionId: props.targetAgentVersionId ?? null,
      configSnapshot: props.configSnapshot,
      checksum: props.checksum,
      evalRunId: props.evalRunId ?? null,
      sourceEvalRunId: props.sourceEvalRunId ?? null,
      warnings: props.warnings ?? null,
      promotedBy: props.promotedBy ?? null,
    });
  }
}
