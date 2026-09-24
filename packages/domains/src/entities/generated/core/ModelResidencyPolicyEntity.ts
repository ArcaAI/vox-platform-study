/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { ModelResidencyClass } from '../../../enums';

// TASK-1005 §5.2 — the DESIRED residency policy for one (aiModelId, service)
// pair. SYSTEM-only platform configuration: every row is written by a
// platform admin and always carries the reserved SYSTEM tenantId (D-11 —
// "Platform-admin only; tenants never see this surface"). See the Prisma
// model header (`model-residency-policy.prisma`) for the full grain
// rationale and why this is a typed table rather than `_metadata` JSONB on
// `AiModel`.
//
// `service` is a plain string, not an enum, validated here against the fixed
// workload vocabulary — mirrors `AiRoutingPolicyEntity` leaving `taskKey`
// unvalidated-by-type and validated by the application layer instead, except
// here the vocabulary is small and stable enough to check structurally.
export const MODEL_RESIDENCY_SERVICES = ['stt', 'stt-worker', 'nlp', 'lm-studio', 'text'] as const;
export type ModelResidencyService = (typeof MODEL_RESIDENCY_SERVICES)[number];

export interface IModelResidencyPolicyEntity extends IBaseTenantEntity {
  /** FK → AiModel.id. A policy can never name a model that does not exist. */
  aiModelId: string;
  /** The workload this policy applies to — see `MODEL_RESIDENCY_SERVICES`. */
  service: string;
  /** Desired residency class; `ON_DEMAND` mirrors the controller's own no-row default. */
  class: ModelResidencyClass;
  /** Idle TTL before an unpinned resident is unloaded. `null` defers to the service's own cache default. */
  idleTtlSeconds?: number | null;
  /** Eviction/placement ordering hint; higher = more valuable to keep resident. */
  priority: number;
  /** Ceiling on concurrently-resident instances of this pair across devices. */
  maxInstances: number;
  /** Advisory device placement hint (e.g. a GPU id, or `cpu`). Never a guarantee. */
  preferredDevice?: string | null;
}

export class ModelResidencyPolicyEntity extends BaseTenantEntity {
  private _aiModelId: IModelResidencyPolicyEntity['aiModelId'];
  private _service: IModelResidencyPolicyEntity['service'];
  private _class: IModelResidencyPolicyEntity['class'];
  private _idleTtlSeconds?: IModelResidencyPolicyEntity['idleTtlSeconds'];
  private _priority: IModelResidencyPolicyEntity['priority'];
  private _maxInstances: IModelResidencyPolicyEntity['maxInstances'];
  private _preferredDevice?: IModelResidencyPolicyEntity['preferredDevice'];

  constructor(init: IModelResidencyPolicyEntity) {
    super(init);
    this._aiModelId = init.aiModelId;
    this._service = init.service;
    this._class = init.class;
    this._idleTtlSeconds = init.idleTtlSeconds;
    this._priority = init.priority;
    this._maxInstances = init.maxInstances;
    this._preferredDevice = init.preferredDevice;
  }

  get aiModelId(): IModelResidencyPolicyEntity['aiModelId'] {
    return this._aiModelId;
  }

  set aiModelId(value: IModelResidencyPolicyEntity['aiModelId']) {
    this.setProperty('aiModelId', value);
  }

  get service(): IModelResidencyPolicyEntity['service'] {
    return this._service;
  }

  set service(value: IModelResidencyPolicyEntity['service']) {
    this.setProperty('service', value);
  }

  get class(): IModelResidencyPolicyEntity['class'] {
    return this._class;
  }

  set class(value: IModelResidencyPolicyEntity['class']) {
    this.setProperty('class', value);
  }

  get idleTtlSeconds(): IModelResidencyPolicyEntity['idleTtlSeconds'] {
    return this._idleTtlSeconds;
  }

  set idleTtlSeconds(value: IModelResidencyPolicyEntity['idleTtlSeconds']) {
    this.setProperty('idleTtlSeconds', value);
  }

  get priority(): IModelResidencyPolicyEntity['priority'] {
    return this._priority;
  }

  set priority(value: IModelResidencyPolicyEntity['priority']) {
    this.setProperty('priority', value);
  }

  get maxInstances(): IModelResidencyPolicyEntity['maxInstances'] {
    return this._maxInstances;
  }

  set maxInstances(value: IModelResidencyPolicyEntity['maxInstances']) {
    this.setProperty('maxInstances', value);
  }

  get preferredDevice(): IModelResidencyPolicyEntity['preferredDevice'] {
    return this._preferredDevice;
  }

  set preferredDevice(value: IModelResidencyPolicyEntity['preferredDevice']) {
    this.setProperty('preferredDevice', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._aiModelId || this._aiModelId.trim().length === 0) {
      throw new BusinessException('A model residency policy must name a model (aiModelId)');
    }
    if (!MODEL_RESIDENCY_SERVICES.includes(this._service as ModelResidencyService)) {
      throw new BusinessException(`Unknown residency service '${this._service}' — expected one of ${MODEL_RESIDENCY_SERVICES.join(', ')}`);
    }
    if (!Object.values(ModelResidencyClass).includes(this._class)) {
      throw new BusinessException(`Unknown residency class '${this._class}'`);
    }
    if (this._idleTtlSeconds !== null && this._idleTtlSeconds !== undefined) {
      if (!Number.isInteger(this._idleTtlSeconds) || this._idleTtlSeconds < 0) {
        throw new BusinessException('idleTtlSeconds must be a non-negative integer');
      }
    }
    if (!Number.isInteger(this._priority)) {
      throw new BusinessException('priority must be an integer');
    }
    if (!Number.isInteger(this._maxInstances) || this._maxInstances < 1) {
      throw new BusinessException('maxInstances must be an integer of at least 1');
    }
  }
}
