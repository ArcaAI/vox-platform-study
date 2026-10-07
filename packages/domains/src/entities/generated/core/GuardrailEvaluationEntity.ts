/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * TASK-1050 — one guardrail evaluation of one text-generation request in one
 * direction (§9.8.2). Append-only audit fact: no `resourceStatus` (never
 * soft-deleted) and identity/verdict columns are read-only once created.
 *
 * `id` IS the `evaluationId` guardrail minted before it answered; the gateway's
 * outbox drain is idempotent on it. `checks` is the per-check result array
 * (no content, no judge reasoning). The only content is the withheld output of
 * an outbound block, as Vault-Transit (hope-phi) ciphertext + `keyVersion`.
 */
export interface IGuardrailEvaluationEntity extends IBaseTenantEntity {
  requestId: string;
  consultationId?: string | null;
  runId?: string | null;
  runKey?: string | null;
  nodeId?: string | null;
  agentSlug?: string | null;
  caller: string;
  direction: Enums.GuardrailDirection;
  decision: Enums.GuardrailDecision;
  exempt?: string | null;
  checks: JsonValue;
  policyVersion: string;
  noticeIds: string[];
  encryptedWithheldContent?: Buffer | null;
  keyVersion?: number | null;
  at: Date;
}

export class GuardrailEvaluationEntity extends BaseTenantEntity {
  private _metaData?: IGuardrailEvaluationEntity['metaData'];
  private _requestId: IGuardrailEvaluationEntity['requestId'];
  private _consultationId?: IGuardrailEvaluationEntity['consultationId'];
  private _runId?: IGuardrailEvaluationEntity['runId'];
  private _runKey?: IGuardrailEvaluationEntity['runKey'];
  private _nodeId?: IGuardrailEvaluationEntity['nodeId'];
  private _agentSlug?: IGuardrailEvaluationEntity['agentSlug'];
  private _caller: IGuardrailEvaluationEntity['caller'];
  private _direction: IGuardrailEvaluationEntity['direction'];
  private _decision: IGuardrailEvaluationEntity['decision'];
  private _exempt?: IGuardrailEvaluationEntity['exempt'];
  private _checks: IGuardrailEvaluationEntity['checks'];
  private _policyVersion: IGuardrailEvaluationEntity['policyVersion'];
  private _noticeIds: IGuardrailEvaluationEntity['noticeIds'];
  private _encryptedWithheldContent?: IGuardrailEvaluationEntity['encryptedWithheldContent'];
  private _keyVersion?: IGuardrailEvaluationEntity['keyVersion'];
  private _at: IGuardrailEvaluationEntity['at'];

  constructor(init: IGuardrailEvaluationEntity) {
    super(init);
    this._metaData = init.metaData;
    this._requestId = init.requestId;
    this._consultationId = init.consultationId;
    this._runId = init.runId;
    this._runKey = init.runKey;
    this._nodeId = init.nodeId;
    this._agentSlug = init.agentSlug;
    this._caller = init.caller;
    this._direction = init.direction;
    this._decision = init.decision;
    this._exempt = init.exempt;
    this._checks = init.checks;
    this._policyVersion = init.policyVersion;
    this._noticeIds = init.noticeIds ?? [];
    this._encryptedWithheldContent = init.encryptedWithheldContent;
    this._keyVersion = init.keyVersion;
    this._at = init.at;
  }

  get metaData(): IGuardrailEvaluationEntity['metaData'] {
    return this._metaData;
  }

  get requestId(): IGuardrailEvaluationEntity['requestId'] {
    return this._requestId;
  }

  get consultationId(): IGuardrailEvaluationEntity['consultationId'] {
    return this._consultationId;
  }

  get runId(): IGuardrailEvaluationEntity['runId'] {
    return this._runId;
  }

  get runKey(): IGuardrailEvaluationEntity['runKey'] {
    return this._runKey;
  }

  get nodeId(): IGuardrailEvaluationEntity['nodeId'] {
    return this._nodeId;
  }

  get agentSlug(): IGuardrailEvaluationEntity['agentSlug'] {
    return this._agentSlug;
  }

  get caller(): IGuardrailEvaluationEntity['caller'] {
    return this._caller;
  }

  get direction(): IGuardrailEvaluationEntity['direction'] {
    return this._direction;
  }

  get decision(): IGuardrailEvaluationEntity['decision'] {
    return this._decision;
  }

  get exempt(): IGuardrailEvaluationEntity['exempt'] {
    return this._exempt;
  }

  get checks(): IGuardrailEvaluationEntity['checks'] {
    return this._checks;
  }

  get policyVersion(): IGuardrailEvaluationEntity['policyVersion'] {
    return this._policyVersion;
  }

  /** The notices raised from this evaluation. Set by the gateway before the insert. */
  get noticeIds(): IGuardrailEvaluationEntity['noticeIds'] {
    return this._noticeIds;
  }

  set noticeIds(value: IGuardrailEvaluationEntity['noticeIds']) {
    this.setProperty('noticeIds', value);
  }

  /** Outbound block only: Vault-Transit ciphertext of the withheld generation. */
  get encryptedWithheldContent(): IGuardrailEvaluationEntity['encryptedWithheldContent'] {
    return this._encryptedWithheldContent;
  }

  set encryptedWithheldContent(value: IGuardrailEvaluationEntity['encryptedWithheldContent']) {
    this.setProperty('encryptedWithheldContent', value);
  }

  get keyVersion(): IGuardrailEvaluationEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: IGuardrailEvaluationEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get at(): IGuardrailEvaluationEntity['at'] {
    return this._at;
  }

  public override validate(): void {
    super.validate();
    if (!this.id) throw new BusinessException('GuardrailEvaluation: evaluationId is required');
    if (!this._requestId) throw new BusinessException('GuardrailEvaluation: requestId is required');
    if (!this._caller) throw new BusinessException('GuardrailEvaluation: caller is required');
    if (!this._policyVersion) throw new BusinessException('GuardrailEvaluation: policyVersion is required');
    if (!this._at) throw new BusinessException('GuardrailEvaluation: at is required');
    if (!Array.isArray(this._checks)) throw new BusinessException('GuardrailEvaluation: checks must be an array');
    const hasWithheld = !!this._encryptedWithheldContent && this._encryptedWithheldContent.length > 0;
    if (hasWithheld && !(this._direction === Enums.GuardrailDirection.OUTBOUND && this._decision === Enums.GuardrailDecision.BLOCK)) {
      throw new BusinessException('GuardrailEvaluation: withheld content is only stored for an OUTBOUND BLOCK');
    }
  }
}
