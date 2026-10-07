/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/** Why a platform guardrail policy value changed (§11.3 B/C). */
export type GuardrailPolicyRevisionReason = 'edit' | 'reset' | 'restore' | 'seed';
export const GUARDRAIL_POLICY_REVISION_REASONS: readonly GuardrailPolicyRevisionReason[] = ['edit', 'reset', 'restore', 'seed'];

/**
 * TASK-1050 — one append-only revision of one platform guardrail policy key
 * (`_metadata.policy[policyKey]` on the SYSTEM guardrail AiModel row
 * `aiModelId`). SYSTEM-tenant rows; every column is read-only once created.
 */
export interface IGuardrailPolicyRevisionEntity extends IBaseTenantEntity {
  aiModelId: string;
  policyKey: string;
  value: JsonValue;
  valueHash: string;
  actorId: string;
  reason: string;
  restoredFromRevisionId?: string | null;
  at: Date;
}

export class GuardrailPolicyRevisionEntity extends BaseTenantEntity {
  private _metaData?: IGuardrailPolicyRevisionEntity['metaData'];
  private _aiModelId: IGuardrailPolicyRevisionEntity['aiModelId'];
  private _policyKey: IGuardrailPolicyRevisionEntity['policyKey'];
  private _value: IGuardrailPolicyRevisionEntity['value'];
  private _valueHash: IGuardrailPolicyRevisionEntity['valueHash'];
  private _actorId: IGuardrailPolicyRevisionEntity['actorId'];
  private _reason: IGuardrailPolicyRevisionEntity['reason'];
  private _restoredFromRevisionId?: IGuardrailPolicyRevisionEntity['restoredFromRevisionId'];
  private _at: IGuardrailPolicyRevisionEntity['at'];

  constructor(init: IGuardrailPolicyRevisionEntity) {
    super(init);
    this._metaData = init.metaData;
    this._aiModelId = init.aiModelId;
    this._policyKey = init.policyKey;
    this._value = init.value;
    this._valueHash = init.valueHash;
    this._actorId = init.actorId;
    this._reason = init.reason;
    this._restoredFromRevisionId = init.restoredFromRevisionId;
    this._at = init.at;
  }

  get metaData(): IGuardrailPolicyRevisionEntity['metaData'] {
    return this._metaData;
  }

  get aiModelId(): IGuardrailPolicyRevisionEntity['aiModelId'] {
    return this._aiModelId;
  }

  get policyKey(): IGuardrailPolicyRevisionEntity['policyKey'] {
    return this._policyKey;
  }

  get value(): IGuardrailPolicyRevisionEntity['value'] {
    return this._value;
  }

  get valueHash(): IGuardrailPolicyRevisionEntity['valueHash'] {
    return this._valueHash;
  }

  get actorId(): IGuardrailPolicyRevisionEntity['actorId'] {
    return this._actorId;
  }

  get reason(): IGuardrailPolicyRevisionEntity['reason'] {
    return this._reason;
  }

  get restoredFromRevisionId(): IGuardrailPolicyRevisionEntity['restoredFromRevisionId'] {
    return this._restoredFromRevisionId;
  }

  get at(): IGuardrailPolicyRevisionEntity['at'] {
    return this._at;
  }

  public override validate(): void {
    super.validate();
    if (!this._aiModelId) throw new BusinessException('GuardrailPolicyRevision: aiModelId is required');
    if (!this._policyKey) throw new BusinessException('GuardrailPolicyRevision: policyKey is required');
    if (!this._valueHash) throw new BusinessException('GuardrailPolicyRevision: valueHash is required');
    if (!this._actorId) throw new BusinessException('GuardrailPolicyRevision: actorId is required');
    if (!GUARDRAIL_POLICY_REVISION_REASONS.includes(this._reason as GuardrailPolicyRevisionReason)) {
      throw new BusinessException(`GuardrailPolicyRevision: unknown reason "${this._reason}"`);
    }
    if (this._reason === 'restore' && !this._restoredFromRevisionId) {
      throw new BusinessException('GuardrailPolicyRevision: a restore needs restoredFromRevisionId');
    }
  }
}
