/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { GuardrailPolicyRevisionEntity, GuardrailPolicyRevisionReason, IGuardrailPolicyRevisionEntity } from '../../../entities';
import * as Enums from '../../../enums';

export interface CreateGuardrailPolicyRevisionProps extends BaseEntityFactoryCreateProps {
  tenantId: IGuardrailPolicyRevisionEntity['tenantId'];
  aiModelId: IGuardrailPolicyRevisionEntity['aiModelId'];
  policyKey: IGuardrailPolicyRevisionEntity['policyKey'];
  value: IGuardrailPolicyRevisionEntity['value'];
  valueHash: IGuardrailPolicyRevisionEntity['valueHash'];
  actorId: IGuardrailPolicyRevisionEntity['actorId'];
  reason: GuardrailPolicyRevisionReason;
  restoredFromRevisionId?: IGuardrailPolicyRevisionEntity['restoredFromRevisionId'];
  at?: IGuardrailPolicyRevisionEntity['at'];
  metaData?: IGuardrailPolicyRevisionEntity['metaData'];
  createdAt?: IGuardrailPolicyRevisionEntity['createdAt'];
  createdBy?: IGuardrailPolicyRevisionEntity['createdBy'];
}

export class GuardrailPolicyRevisionFactory {
  /** Create one append-only revision (SYSTEM tenant). `at` defaults to now. */
  static CreateGuardrailPolicyRevision(props: CreateGuardrailPolicyRevisionProps): GuardrailPolicyRevisionEntity {
    const now = new Date();

    return new GuardrailPolicyRevisionEntity({
      id: generateId(),
      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: props.createdBy ?? props.actorId ?? null,
      updatedBy: null,
      metaData: props.metaData,
      tenantId: props.tenantId,
      aiModelId: props.aiModelId,
      policyKey: props.policyKey,
      value: props.value,
      valueHash: props.valueHash,
      actorId: props.actorId,
      reason: props.reason,
      restoredFromRevisionId: props.restoredFromRevisionId ?? null,
      at: props.at ?? now,
    });
  }
}
