/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/** How a notice was acknowledged: the notice's own ack route, or atomically inside approve (§9.8.3). */
export type GuardrailNoticeAcknowledgedVia = 'notice' | 'approve';
export const GUARDRAIL_NOTICE_ACKNOWLEDGED_VIA: readonly GuardrailNoticeAcknowledgedVia[] = ['notice', 'approve'];

/** How a hold/notice was resolved (§9.7.5, OD-18). */
export type GuardrailNoticeResolution = 'item_excluded' | 'item_edited' | 'acknowledged';
export const GUARDRAIL_NOTICE_RESOLUTIONS: readonly GuardrailNoticeResolution[] = ['item_excluded', 'item_edited', 'acknowledged'];

/**
 * TASK-1050 — the standard client message (`GuardrailNotice` v1, §9.7.3) plus
 * its acknowledgement / resolution state. PHI-free: `checks` carries
 * `{ checkId, category, severity }` only. No `resourceStatus` (never deleted);
 * its life is `status` OPEN → ACKNOWLEDGED → RESOLVED, moved forward only by
 * {@link acknowledge} / {@link resolve}. OCC-written (`_version`).
 */
export interface IGuardrailNoticeEntity extends IBaseTenantEntity {
  consultationId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  type: Enums.GuardrailNoticeType;
  direction: Enums.GuardrailDirection;
  action: string;
  checks: JsonValue;
  itemIds: string[];
  messageKey: string;
  severity: string;
  requiresAcknowledgement: boolean;
  resumable: boolean;
  policyVersion: string;
  dedupeKey: string;
  status: Enums.GuardrailNoticeStatus;
  acknowledgedBy?: string | null;
  acknowledgedAt?: Date | null;
  acknowledgedVia?: string | null;
  resolution?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: Date | null;
}

export class GuardrailNoticeEntity extends BaseTenantEntity {
  private _metaData?: IGuardrailNoticeEntity['metaData'];
  private _consultationId?: IGuardrailNoticeEntity['consultationId'];
  private _runId?: IGuardrailNoticeEntity['runId'];
  private _nodeId?: IGuardrailNoticeEntity['nodeId'];
  private _type: IGuardrailNoticeEntity['type'];
  private _direction: IGuardrailNoticeEntity['direction'];
  private _action: IGuardrailNoticeEntity['action'];
  private _checks: IGuardrailNoticeEntity['checks'];
  private _itemIds: IGuardrailNoticeEntity['itemIds'];
  private _messageKey: IGuardrailNoticeEntity['messageKey'];
  private _severity: IGuardrailNoticeEntity['severity'];
  private _requiresAcknowledgement: IGuardrailNoticeEntity['requiresAcknowledgement'];
  private _resumable: IGuardrailNoticeEntity['resumable'];
  private _policyVersion: IGuardrailNoticeEntity['policyVersion'];
  private _dedupeKey: IGuardrailNoticeEntity['dedupeKey'];
  private _status: IGuardrailNoticeEntity['status'];
  private _acknowledgedBy?: IGuardrailNoticeEntity['acknowledgedBy'];
  private _acknowledgedAt?: IGuardrailNoticeEntity['acknowledgedAt'];
  private _acknowledgedVia?: IGuardrailNoticeEntity['acknowledgedVia'];
  private _resolution?: IGuardrailNoticeEntity['resolution'];
  private _resolvedBy?: IGuardrailNoticeEntity['resolvedBy'];
  private _resolvedAt?: IGuardrailNoticeEntity['resolvedAt'];

  constructor(init: IGuardrailNoticeEntity) {
    super(init);
    this._metaData = init.metaData;
    this._consultationId = init.consultationId;
    this._runId = init.runId;
    this._nodeId = init.nodeId;
    this._type = init.type;
    this._direction = init.direction;
    this._action = init.action;
    this._checks = init.checks;
    this._itemIds = init.itemIds ?? [];
    this._messageKey = init.messageKey;
    this._severity = init.severity;
    this._requiresAcknowledgement = init.requiresAcknowledgement ?? false;
    this._resumable = init.resumable ?? false;
    this._policyVersion = init.policyVersion;
    this._dedupeKey = init.dedupeKey;
    this._status = init.status ?? Enums.GuardrailNoticeStatus.OPEN;
    this._acknowledgedBy = init.acknowledgedBy;
    this._acknowledgedAt = init.acknowledgedAt;
    this._acknowledgedVia = init.acknowledgedVia;
    this._resolution = init.resolution;
    this._resolvedBy = init.resolvedBy;
    this._resolvedAt = init.resolvedAt;
  }

  get metaData(): IGuardrailNoticeEntity['metaData'] {
    return this._metaData;
  }

  get consultationId(): IGuardrailNoticeEntity['consultationId'] {
    return this._consultationId;
  }

  get runId(): IGuardrailNoticeEntity['runId'] {
    return this._runId;
  }

  get nodeId(): IGuardrailNoticeEntity['nodeId'] {
    return this._nodeId;
  }

  get type(): IGuardrailNoticeEntity['type'] {
    return this._type;
  }

  get direction(): IGuardrailNoticeEntity['direction'] {
    return this._direction;
  }

  get action(): IGuardrailNoticeEntity['action'] {
    return this._action;
  }

  get checks(): IGuardrailNoticeEntity['checks'] {
    return this._checks;
  }

  get itemIds(): IGuardrailNoticeEntity['itemIds'] {
    return this._itemIds;
  }

  get messageKey(): IGuardrailNoticeEntity['messageKey'] {
    return this._messageKey;
  }

  get severity(): IGuardrailNoticeEntity['severity'] {
    return this._severity;
  }

  get requiresAcknowledgement(): IGuardrailNoticeEntity['requiresAcknowledgement'] {
    return this._requiresAcknowledgement;
  }

  get resumable(): IGuardrailNoticeEntity['resumable'] {
    return this._resumable;
  }

  get policyVersion(): IGuardrailNoticeEntity['policyVersion'] {
    return this._policyVersion;
  }

  get dedupeKey(): IGuardrailNoticeEntity['dedupeKey'] {
    return this._dedupeKey;
  }

  get status(): IGuardrailNoticeEntity['status'] {
    return this._status;
  }

  get acknowledgedBy(): IGuardrailNoticeEntity['acknowledgedBy'] {
    return this._acknowledgedBy;
  }

  get acknowledgedAt(): IGuardrailNoticeEntity['acknowledgedAt'] {
    return this._acknowledgedAt;
  }

  get acknowledgedVia(): IGuardrailNoticeEntity['acknowledgedVia'] {
    return this._acknowledgedVia;
  }

  get resolution(): IGuardrailNoticeEntity['resolution'] {
    return this._resolution;
  }

  get resolvedBy(): IGuardrailNoticeEntity['resolvedBy'] {
    return this._resolvedBy;
  }

  get resolvedAt(): IGuardrailNoticeEntity['resolvedAt'] {
    return this._resolvedAt;
  }

  /**
   * The clinician's attestation that they saw this notice — through the
   * notice's ack route (`via: 'notice'`) or atomically inside approve
   * (`via: 'approve'`, §9.8.3). Refused once the notice is RESOLVED.
   */
  public acknowledge(input: { by: string; via: GuardrailNoticeAcknowledgedVia; at?: Date }): this {
    if (!input.by) throw new BusinessException('GuardrailNotice.acknowledge: the acknowledging actor is required');
    if (!GUARDRAIL_NOTICE_ACKNOWLEDGED_VIA.includes(input.via)) {
      throw new BusinessException(`GuardrailNotice.acknowledge: unknown channel "${String(input.via)}"`);
    }
    if (this._status === Enums.GuardrailNoticeStatus.RESOLVED) {
      throw new BusinessException('GuardrailNotice.acknowledge: the notice is already resolved');
    }
    this.setProperty('status', Enums.GuardrailNoticeStatus.ACKNOWLEDGED);
    this.setProperty('acknowledgedBy', input.by);
    this.setProperty('acknowledgedVia', input.via);
    this.setProperty('acknowledgedAt', input.at ?? new Date());
    return this;
  }

  /** Close the notice with a resolution (a hold resumed, an item excluded or edited). Terminal. */
  public resolve(input: { by: string; resolution: GuardrailNoticeResolution; at?: Date }): this {
    if (!input.by) throw new BusinessException('GuardrailNotice.resolve: the resolving actor is required');
    if (!GUARDRAIL_NOTICE_RESOLUTIONS.includes(input.resolution)) {
      throw new BusinessException(`GuardrailNotice.resolve: unknown resolution "${String(input.resolution)}"`);
    }
    if (this._status === Enums.GuardrailNoticeStatus.RESOLVED) {
      throw new BusinessException('GuardrailNotice.resolve: the notice is already resolved');
    }
    this.setProperty('status', Enums.GuardrailNoticeStatus.RESOLVED);
    this.setProperty('resolution', input.resolution);
    this.setProperty('resolvedBy', input.by);
    this.setProperty('resolvedAt', input.at ?? new Date());
    return this;
  }

  public override validate(): void {
    super.validate();
    if (!this._dedupeKey) throw new BusinessException('GuardrailNotice: dedupeKey is required');
    if (!this._messageKey) throw new BusinessException('GuardrailNotice: messageKey is required');
    if (!this._policyVersion) throw new BusinessException('GuardrailNotice: policyVersion is required');
    if (!this._action) throw new BusinessException('GuardrailNotice: action is required');
    if (!Array.isArray(this._checks)) throw new BusinessException('GuardrailNotice: checks must be an array');
  }
}
