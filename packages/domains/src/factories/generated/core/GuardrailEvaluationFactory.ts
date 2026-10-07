/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GuardrailEvaluationEntity, IGuardrailEvaluationEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateGuardrailEvaluationProps extends BaseEntityFactoryCreateProps {
  /** The `evaluationId` guardrail minted before it answered — REQUIRED, never generated here. */
  id: IGuardrailEvaluationEntity['id'];
  tenantId: IGuardrailEvaluationEntity['tenantId'];
  requestId: IGuardrailEvaluationEntity['requestId'];
  consultationId?: IGuardrailEvaluationEntity['consultationId'];
  runId?: IGuardrailEvaluationEntity['runId'];
  runKey?: IGuardrailEvaluationEntity['runKey'];
  nodeId?: IGuardrailEvaluationEntity['nodeId'];
  agentSlug?: IGuardrailEvaluationEntity['agentSlug'];
  caller: IGuardrailEvaluationEntity['caller'];
  direction: IGuardrailEvaluationEntity['direction'];
  decision: IGuardrailEvaluationEntity['decision'];
  exempt?: IGuardrailEvaluationEntity['exempt'];
  checks: IGuardrailEvaluationEntity['checks'];
  policyVersion: IGuardrailEvaluationEntity['policyVersion'];
  noticeIds?: IGuardrailEvaluationEntity['noticeIds'];
  encryptedWithheldContent?: IGuardrailEvaluationEntity['encryptedWithheldContent'];
  keyVersion?: IGuardrailEvaluationEntity['keyVersion'];
  at: IGuardrailEvaluationEntity['at'];
  metaData?: IGuardrailEvaluationEntity['metaData'];
  createdAt?: IGuardrailEvaluationEntity['createdAt'];
  createdBy?: IGuardrailEvaluationEntity['createdBy'];
}

export class GuardrailEvaluationFactory {
  /**
   * Create one evaluation record. The id is the caller's `evaluationId`, so a
   * redriven outbox batch maps onto the same rows; persist with
   * `GuardrailEvaluationRepository.createManyIdempotent`.
   */
  static CreateGuardrailEvaluation(props: CreateGuardrailEvaluationProps): GuardrailEvaluationEntity {
    if (!props.id) {
      throw new BusinessException('GuardrailEvaluation: the caller-supplied evaluationId is required');
    }
    const now = new Date();

    return new GuardrailEvaluationEntity({
      id: props.id,
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      requestId: props.requestId,
      consultationId: props.consultationId ?? null,
      runId: props.runId ?? null,
      runKey: props.runKey ?? null,
      nodeId: props.nodeId ?? null,
      agentSlug: props.agentSlug ?? null,
      caller: props.caller,
      direction: props.direction,
      decision: props.decision,
      exempt: props.exempt ?? null,
      checks: props.checks,
      policyVersion: props.policyVersion,
      noticeIds: props.noticeIds ?? [],
      encryptedWithheldContent: props.encryptedWithheldContent ?? null,
      keyVersion: props.keyVersion ?? null,
      at: props.at,
    });
  }
}
