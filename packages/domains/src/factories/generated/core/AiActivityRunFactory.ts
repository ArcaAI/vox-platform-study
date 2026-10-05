/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AiActivityRunEntity, IAiActivityRunEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateAiActivityRunProps extends BaseEntityFactoryCreateProps {
  tenantId: IAiActivityRunEntity['tenantId'];
  runKey: IAiActivityRunEntity['runKey'];
  consultationId?: IAiActivityRunEntity['consultationId'];
  encounterSeq?: IAiActivityRunEntity['encounterSeq'];
  activityKind: IAiActivityRunEntity['activityKind'];
  status: IAiActivityRunEntity['status'];
  workflowSlug?: IAiActivityRunEntity['workflowSlug'];
  workflowVersion?: IAiActivityRunEntity['workflowVersion'];
  workflowRunId?: IAiActivityRunEntity['workflowRunId'];
  nodeId?: IAiActivityRunEntity['nodeId'];
  agentId?: IAiActivityRunEntity['agentId'];
  agentSlug?: IAiActivityRunEntity['agentSlug'];
  agentVersion?: IAiActivityRunEntity['agentVersion'];
  promptTemplateId?: IAiActivityRunEntity['promptTemplateId'];
  promptVersion?: IAiActivityRunEntity['promptVersion'];
  model?: IAiActivityRunEntity['model'];
  provider?: IAiActivityRunEntity['provider'];
  deployment?: IAiActivityRunEntity['deployment'];
  startedAt: IAiActivityRunEntity['startedAt'];
  endedAt?: IAiActivityRunEntity['endedAt'];
  durationMs?: IAiActivityRunEntity['durationMs'];
  tokensIn?: IAiActivityRunEntity['tokensIn'];
  tokensOut?: IAiActivityRunEntity['tokensOut'];
  contextUsed?: IAiActivityRunEntity['contextUsed'];
  contextWindow?: IAiActivityRunEntity['contextWindow'];
  outputCap?: IAiActivityRunEntity['outputCap'];
  stopReason?: IAiActivityRunEntity['stopReason'];
  budgetStrategy?: IAiActivityRunEntity['budgetStrategy'];
  callIndex?: IAiActivityRunEntity['callIndex'];
  callCount?: IAiActivityRunEntity['callCount'];
  costMicros?: IAiActivityRunEntity['costMicros'];
  costBasis?: IAiActivityRunEntity['costBasis'];
  usageRequestId?: IAiActivityRunEntity['usageRequestId'];
  errorCode?: IAiActivityRunEntity['errorCode'];
  contextItemId?: IAiActivityRunEntity['contextItemId'];
  outputVersionNumber?: IAiActivityRunEntity['outputVersionNumber'];
  metaData?: IAiActivityRunEntity['metaData'];
  createdAt?: IAiActivityRunEntity['createdAt'];
  createdBy?: IAiActivityRunEntity['createdBy'];
}

export class AiActivityRunFactory {
  /**
   * Create one run record. Persist it with `AiActivityRunRepository.upsertByRunKey`.
   */
  static CreateAiActivityRun(props: CreateAiActivityRunProps): AiActivityRunEntity {
    const id = generateId();
    const now = new Date();

    return new AiActivityRunEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      runKey: props.runKey,
      consultationId: props.consultationId ?? null,
      encounterSeq: props.encounterSeq ?? null,
      activityKind: props.activityKind,
      status: props.status,
      workflowSlug: props.workflowSlug ?? null,
      workflowVersion: props.workflowVersion ?? null,
      workflowRunId: props.workflowRunId ?? null,
      nodeId: props.nodeId ?? null,
      agentId: props.agentId ?? null,
      agentSlug: props.agentSlug ?? null,
      agentVersion: props.agentVersion ?? null,
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersion: props.promptVersion ?? null,
      model: props.model ?? null,
      provider: props.provider ?? null,
      deployment: props.deployment ?? null,
      startedAt: props.startedAt,
      endedAt: props.endedAt ?? null,
      durationMs: props.durationMs ?? null,
      tokensIn: props.tokensIn ?? null,
      tokensOut: props.tokensOut ?? null,
      contextUsed: props.contextUsed ?? null,
      contextWindow: props.contextWindow ?? null,
      outputCap: props.outputCap ?? null,
      stopReason: props.stopReason ?? null,
      budgetStrategy: props.budgetStrategy ?? null,
      callIndex: props.callIndex ?? null,
      callCount: props.callCount ?? null,
      costMicros: props.costMicros ?? null,
      costBasis: props.costBasis ?? null,
      usageRequestId: props.usageRequestId ?? null,
      errorCode: props.errorCode ?? null,
      contextItemId: props.contextItemId ?? null,
      outputVersionNumber: props.outputVersionNumber ?? null,
    });
  }
}
