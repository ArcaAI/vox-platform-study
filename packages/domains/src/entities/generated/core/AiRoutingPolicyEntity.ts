/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import { AiExplicitProviderMode, AiRoutingPolicyStatus, AiRoutingStrategy, AiTaskKind } from '../../../enums';

// ONE PROVIDER CONFIGURATION for one (tenant, taskKey) —, OD-3.
//
// ⚠ THE GRAIN CHANGED. shipped this entity as one row per authored
// POLICY REVISION carrying the whole ordered chain inside `candidatesJson`.
// re-grained it: one row is now ONE CANDIDATE, the chain is the SET of
// rows sharing (tenantId, taskKey) ordered by `priority`, and exactly one of
// them carries `isDefault`. That election is enforced by a PARTIAL UNIQUE INDEX
// in the database (`AiRoutingPolicy_tenant_task_default_unique`), keyed on
// `taskKey` and NOT `taskKind` — see the Prisma model header for why (F-26).
//
// The re-grain absorbed `AiTaskDefault`, which OD-3 retires. Resolution
// (request tenant → SYSTEM, two tiers, widening only on ABSENCE), the
// most-specific-match rules, the explicit-provider gates and the
// health semantics all live in the application service; this entity carries
// only structural invariants.
//
// `policyVersion` is the AUTHORED, supersede-only revision and is NOT the
// `_version` OCC counter inherited from BaseEntity. Both exist on purpose:
// `_version` rejects a concurrent write, `policyVersion` names a revision a
// reviewer can roll back to. It is no longer part of a natural key.
export interface IAiRoutingPolicyEntity extends IBaseTenantEntity {
  taskKey: string;
  // the canonical task taxonomy `taskKey` belongs to, DERIVED from
  // it via `AI_TASK_KIND_BY_TASK_KEY` in the applications layer. Still nullable
  // at the column level so a row written by an un-migrated writer lands
  // "unclassified" rather than plausible-but-wrong; teaches every
  // writer to set it and backfills the rows earlier writers left NULL.
  taskKind?: AiTaskKind | null;

  // ─────────── — the provider-configuration binding ───────────
  /** Human label for this configuration. Not a key. */
  displayName?: string | null;
  /** FK → AiProviderConnection.id. Replaces the `connectionRef` string. */
  providerConnectionId?: string | null;
  /** FK → AiModel.id. Replaces `AiTaskDefault.modelSlug`'s by-slug reference. */
  modelId?: string | null;
  /** Provider-side model id on the wire (Azure deployment, GGUF id) when it differs from the catalogue slug. */
  modelRef?: string | null;
  /** The elected default for this (tenantId, taskKey). At most one per selection — DB-enforced. */
  isDefault: boolean;
  /** Candidate on/off without deleting the row. */
  enabled: boolean;
  /** Opaque residency-class label; compared for EQUALITY only by the gates. */
  residency?: string | null;
  /** Whether a BAA covers this vendor AND this model. */
  baaCovered?: boolean | null;
  /** Task-specific extras absorbed from `AiTaskDefault.configJson`. */
  configJson?: JsonValue | null;

  policyVersion: number;
  status: AiRoutingPolicyStatus;
  strategy: AiRoutingStrategy;
  explicitProviderMode: AiExplicitProviderMode;
  priority: number;
  killSwitch: boolean;
  matchJson?: JsonValue | null;
  /**
   * ⚠ DEPRECATED by and no longer read by the resolver. The ordered
   * chain is now the SET of rows sharing (tenantId, taskKey). Nullable so a
   * earlier revision stays readable; never write it.
 */
  candidatesJson?: JsonValue | null;
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
  private _taskKind?: IAiRoutingPolicyEntity['taskKind'];
  private _displayName?: IAiRoutingPolicyEntity['displayName'];
  private _providerConnectionId?: IAiRoutingPolicyEntity['providerConnectionId'];
  private _modelId?: IAiRoutingPolicyEntity['modelId'];
  private _modelRef?: IAiRoutingPolicyEntity['modelRef'];
  private _isDefault: IAiRoutingPolicyEntity['isDefault'];
  private _enabled: IAiRoutingPolicyEntity['enabled'];
  private _residency?: IAiRoutingPolicyEntity['residency'];
  private _baaCovered?: IAiRoutingPolicyEntity['baaCovered'];
  private _configJson?: IAiRoutingPolicyEntity['configJson'];
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
    this._taskKind = init.taskKind;
    this._displayName = init.displayName;
    this._providerConnectionId = init.providerConnectionId;
    this._modelId = init.modelId;
    this._modelRef = init.modelRef;
    this._isDefault = init.isDefault;
    this._enabled = init.enabled;
    this._residency = init.residency;
    this._baaCovered = init.baaCovered;
    this._configJson = init.configJson;
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

  get taskKind(): IAiRoutingPolicyEntity['taskKind'] {
    return this._taskKind;
  }

  set taskKind(value: IAiRoutingPolicyEntity['taskKind']) {
    this.setProperty('taskKind', value);
  }

  get displayName(): IAiRoutingPolicyEntity['displayName'] {
    return this._displayName;
  }

  set displayName(value: IAiRoutingPolicyEntity['displayName']) {
    this.setProperty('displayName', value);
  }

  get providerConnectionId(): IAiRoutingPolicyEntity['providerConnectionId'] {
    return this._providerConnectionId;
  }

  set providerConnectionId(value: IAiRoutingPolicyEntity['providerConnectionId']) {
    this.setProperty('providerConnectionId', value);
  }

  get modelId(): IAiRoutingPolicyEntity['modelId'] {
    return this._modelId;
  }

  set modelId(value: IAiRoutingPolicyEntity['modelId']) {
    this.setProperty('modelId', value);
  }

  get modelRef(): IAiRoutingPolicyEntity['modelRef'] {
    return this._modelRef;
  }

  set modelRef(value: IAiRoutingPolicyEntity['modelRef']) {
    this.setProperty('modelRef', value);
  }

  get isDefault(): IAiRoutingPolicyEntity['isDefault'] {
    return this._isDefault;
  }

  set isDefault(value: IAiRoutingPolicyEntity['isDefault']) {
    this.setProperty('isDefault', value);
  }

  get enabled(): IAiRoutingPolicyEntity['enabled'] {
    return this._enabled;
  }

  set enabled(value: IAiRoutingPolicyEntity['enabled']) {
    this.setProperty('enabled', value);
  }

  get residency(): IAiRoutingPolicyEntity['residency'] {
    return this._residency;
  }

  set residency(value: IAiRoutingPolicyEntity['residency']) {
    this.setProperty('residency', value);
  }

  get baaCovered(): IAiRoutingPolicyEntity['baaCovered'] {
    return this._baaCovered;
  }

  set baaCovered(value: IAiRoutingPolicyEntity['baaCovered']) {
    this.setProperty('baaCovered', value);
  }

  get configJson(): IAiRoutingPolicyEntity['configJson'] {
    return this._configJson;
  }

  set configJson(value: IAiRoutingPolicyEntity['configJson']) {
    this.setProperty('configJson', value);
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
    // A configuration that names nothing to route TO cannot route, so it is not
    // a configuration. This replaces "at least one candidate in
    // `candidatesJson`" invariant, which belonged to the old one-row-per-policy
    // grain: at THIS grain the row IS the candidate, so the binding lives in
    // `modelId` / `modelRef`.
    //
    // The third arm keeps a earlier revision loadable — those rows carry a
    // populated `candidatesJson` and no binding columns, and refusing them would
    // make historical revisions unreadable rather than merely deprecated.
    //
    // Structural only. WHICH model, WHICH connection, and whether the credential
    // resolves are the application service's business — that is where the
    // tenant → SYSTEM cascade and the gates live.
    const hasBinding = Boolean(this._modelId) || Boolean(this._modelRef);
    const hasLegacyChain = Array.isArray(this._candidatesJson) && this._candidatesJson.length > 0;
    if (!hasBinding && !hasLegacyChain) {
      throw new BusinessException('A routing configuration must name a model (modelId or modelRef)');
    }
  }
}
