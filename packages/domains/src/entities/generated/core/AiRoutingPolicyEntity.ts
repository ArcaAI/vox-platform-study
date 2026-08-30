/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { AiExplicitProviderMode, AiRoutingPolicyStatus, AiRoutingStrategy } from '../../../enums';

// The ORDERED candidate chain that serves one (tenant, taskKey) — TASK-818
// §3A.3. One row per authored revision; the reserved SYSTEM tenant row is the
// platform default. Resolution (request tenant → SYSTEM, two tiers), the
// most-specific-match rules, the §3A.4 explicit-provider gates and the §3A.5
// health semantics all live in the application service; this entity carries
// only structural invariants.
//
// `policyVersion` is the AUTHORED, supersede-only revision and is NOT the
// `_version` OCC counter inherited from BaseEntity. Both exist on purpose:
// `_version` rejects a concurrent write, `policyVersion` names a revision a
// reviewer can roll back to.
export interface IAiRoutingPolicyEntity extends IBaseTenantEntity {
  taskKey: string;
  policyVersion: number;
  status: AiRoutingPolicyStatus;
  strategy: AiRoutingStrategy;
  explicitProviderMode: AiExplicitProviderMode;
  priority: number;
  killSwitch: boolean;
  matchJson?: JsonValue | null;
  candidatesJson: JsonValue;
  fallbackJson?: JsonValue | null;
  healthJson?: JsonValue | null;
  maxConcurrentStreams?: number | null;
  requestsPerMinute?: number | null;
  tokensPerMinute?: number | null;
  affinityJson?: JsonValue | null;
  supersedesVersion?: number | null;
  activatedAt?: Date | null;
}

export class AiRoutingPolicyEntity extends BaseTenantEntity {
  private _taskKey: IAiRoutingPolicyEntity['taskKey'];
  private _policyVersion: IAiRoutingPolicyEntity['policyVersion'];
  private _status: IAiRoutingPolicyEntity['status'];
  private _strategy: IAiRoutingPolicyEntity['strategy'];
  private _explicitProviderMode: IAiRoutingPolicyEntity['explicitProviderMode'];
  private _priority: IAiRoutingPolicyEntity['priority'];
  private _killSwitch: IAiRoutingPolicyEntity['killSwitch'];
  private _matchJson?: IAiRoutingPolicyEntity['matchJson'];
  private _candidatesJson: IAiRoutingPolicyEntity['candidatesJson'];
  private _fallbackJson?: IAiRoutingPolicyEntity['fallbackJson'];
  private _healthJson?: IAiRoutingPolicyEntity['healthJson'];
  private _maxConcurrentStreams?: IAiRoutingPolicyEntity['maxConcurrentStreams'];
  private _requestsPerMinute?: IAiRoutingPolicyEntity['requestsPerMinute'];
  private _tokensPerMinute?: IAiRoutingPolicyEntity['tokensPerMinute'];
  private _affinityJson?: IAiRoutingPolicyEntity['affinityJson'];
  private _supersedesVersion?: IAiRoutingPolicyEntity['supersedesVersion'];
  private _activatedAt?: IAiRoutingPolicyEntity['activatedAt'];

  constructor(init: IAiRoutingPolicyEntity) {
    super(init);
    this._taskKey = init.taskKey;
    this._policyVersion = init.policyVersion;
    this._status = init.status;
    this._strategy = init.strategy;
    this._explicitProviderMode = init.explicitProviderMode;
    this._priority = init.priority;
    this._killSwitch = init.killSwitch;
    this._matchJson = init.matchJson;
    this._candidatesJson = init.candidatesJson;
    this._fallbackJson = init.fallbackJson;
    this._healthJson = init.healthJson;
    this._maxConcurrentStreams = init.maxConcurrentStreams;
    this._requestsPerMinute = init.requestsPerMinute;
    this._tokensPerMinute = init.tokensPerMinute;
    this._affinityJson = init.affinityJson;
    this._supersedesVersion = init.supersedesVersion;
    this._activatedAt = init.activatedAt;
  }

  get taskKey(): IAiRoutingPolicyEntity['taskKey'] {
    return this._taskKey;
  }

  set taskKey(value: IAiRoutingPolicyEntity['taskKey']) {
    this.setProperty('taskKey', value);
  }

  get policyVersion(): IAiRoutingPolicyEntity['policyVersion'] {
    return this._policyVersion;
  }

  set policyVersion(value: IAiRoutingPolicyEntity['policyVersion']) {
    this.setProperty('policyVersion', value);
  }

  get status(): IAiRoutingPolicyEntity['status'] {
    return this._status;
  }

  set status(value: IAiRoutingPolicyEntity['status']) {
    this.setProperty('status', value);
  }

  get strategy(): IAiRoutingPolicyEntity['strategy'] {
    return this._strategy;
  }

  set strategy(value: IAiRoutingPolicyEntity['strategy']) {
    this.setProperty('strategy', value);
  }

  get explicitProviderMode(): IAiRoutingPolicyEntity['explicitProviderMode'] {
    return this._explicitProviderMode;
  }

  set explicitProviderMode(value: IAiRoutingPolicyEntity['explicitProviderMode']) {
    this.setProperty('explicitProviderMode', value);
  }

  get priority(): IAiRoutingPolicyEntity['priority'] {
    return this._priority;
  }

  set priority(value: IAiRoutingPolicyEntity['priority']) {
    this.setProperty('priority', value);
  }

  get killSwitch(): IAiRoutingPolicyEntity['killSwitch'] {
    return this._killSwitch;
  }

  set killSwitch(value: IAiRoutingPolicyEntity['killSwitch']) {
    this.setProperty('killSwitch', value);
  }

  get matchJson(): IAiRoutingPolicyEntity['matchJson'] {
    return this._matchJson;
  }

  set matchJson(value: IAiRoutingPolicyEntity['matchJson']) {
    this.setProperty('matchJson', value);
  }

  get candidatesJson(): IAiRoutingPolicyEntity['candidatesJson'] {
    return this._candidatesJson;
  }

  set candidatesJson(value: IAiRoutingPolicyEntity['candidatesJson']) {
    this.setProperty('candidatesJson', value);
  }

  get fallbackJson(): IAiRoutingPolicyEntity['fallbackJson'] {
    return this._fallbackJson;
  }

  set fallbackJson(value: IAiRoutingPolicyEntity['fallbackJson']) {
    this.setProperty('fallbackJson', value);
  }

  get healthJson(): IAiRoutingPolicyEntity['healthJson'] {
    return this._healthJson;
  }

  set healthJson(value: IAiRoutingPolicyEntity['healthJson']) {
    this.setProperty('healthJson', value);
  }

  get maxConcurrentStreams(): IAiRoutingPolicyEntity['maxConcurrentStreams'] {
    return this._maxConcurrentStreams;
  }

  set maxConcurrentStreams(value: IAiRoutingPolicyEntity['maxConcurrentStreams']) {
    this.setProperty('maxConcurrentStreams', value);
  }

  get requestsPerMinute(): IAiRoutingPolicyEntity['requestsPerMinute'] {
    return this._requestsPerMinute;
  }

  set requestsPerMinute(value: IAiRoutingPolicyEntity['requestsPerMinute']) {
    this.setProperty('requestsPerMinute', value);
  }

  get tokensPerMinute(): IAiRoutingPolicyEntity['tokensPerMinute'] {
    return this._tokensPerMinute;
  }

  set tokensPerMinute(value: IAiRoutingPolicyEntity['tokensPerMinute']) {
    this.setProperty('tokensPerMinute', value);
  }

  get affinityJson(): IAiRoutingPolicyEntity['affinityJson'] {
    return this._affinityJson;
  }

  set affinityJson(value: IAiRoutingPolicyEntity['affinityJson']) {
    this.setProperty('affinityJson', value);
  }

  get supersedesVersion(): IAiRoutingPolicyEntity['supersedesVersion'] {
    return this._supersedesVersion;
  }

  set supersedesVersion(value: IAiRoutingPolicyEntity['supersedesVersion']) {
    this.setProperty('supersedesVersion', value);
  }

  get activatedAt(): IAiRoutingPolicyEntity['activatedAt'] {
    return this._activatedAt;
  }

  set activatedAt(value: IAiRoutingPolicyEntity['activatedAt']) {
    this.setProperty('activatedAt', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._taskKey || this._taskKey.trim().length === 0) {
      throw new BusinessException('Task key is required');
    }
    // The authored revision is part of the natural key and the rollback
    // target, so it must be a positive integer.
    if (!Number.isInteger(this._policyVersion) || this._policyVersion < 1) {
      throw new BusinessException('Policy version must be a positive integer');
    }
    // A policy with no candidates cannot route anything, so it is not a policy.
    // Structural only — rank/weight/residency/BAA validation belongs to the
    // application service, which is where the §3A.4 gates are enforced.
    if (!Array.isArray(this._candidatesJson) || this._candidatesJson.length === 0) {
      throw new BusinessException('At least one routing candidate is required');
    }
  }
}
