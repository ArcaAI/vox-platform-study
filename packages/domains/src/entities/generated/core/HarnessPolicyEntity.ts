/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Editable, tenant-scoped harness runtime policy.
 *
 * The reserved system tenant `00000000-0000-0000-0000-000000000000` owns the
 * GLOBAL-DEFAULT row; a per-tenant row OVERRIDES it. `_version` is the
 * optimistic-concurrency token (mutated only by `Repository.updateWithVersion`).
 * Field defaults mirror the harness code defaults so a fresh row is a faithful
 * snapshot of `sensors/config.py` + `core/config.py`.
 */
export interface IHarnessPolicyEntity extends IBaseTenantEntity {
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  smrProvider?: string | null;
  smrModel?: string | null;
  maxRegen: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  toolAllowlist?: JsonValue | null;
  // agentic loop knobs. null ⇒ harness env/code default.
  optimisticDeliveryEnabled?: boolean | null;
  atomicFactEnabled?: boolean | null;
  retrievalEnabled?: boolean | null;
  warmStartEnabled?: boolean | null;
  nerPriorsEnabled?: boolean | null;
  maxEditReruns?: number | null;
  regenFeedbackEnabled?: boolean | null;
  // Per-tenant gate for the whole MCP external-tools path. `null` = OFF: the
  // path stays dormant unless a super admin explicitly flips this AND the
  // referenced `McpServer.enabled` is true. Same per-field fallthrough as the
  // knobs above (see harness.prisma).
  mcpToolsEnabled?: boolean | null;
}

export class HarnessPolicyEntity extends BaseTenantEntity {
  private _entityFaithfulnessThreshold: IHarnessPolicyEntity['entityFaithfulnessThreshold'];
  private _coverageThreshold: IHarnessPolicyEntity['coverageThreshold'];
  private _citationPresenceThreshold: IHarnessPolicyEntity['citationPresenceThreshold'];
  private _numericDoseThreshold: IHarnessPolicyEntity['numericDoseThreshold'];
  private _groundednessThreshold: IHarnessPolicyEntity['groundednessThreshold'];
  private _safetyEnabled: IHarnessPolicyEntity['safetyEnabled'];
  private _phiEnabled: IHarnessPolicyEntity['phiEnabled'];
  private _phiFailClosed: IHarnessPolicyEntity['phiFailClosed'];
  private _safetyProvider: IHarnessPolicyEntity['safetyProvider'];
  private _safetyModel: IHarnessPolicyEntity['safetyModel'];
  private _smrProvider?: IHarnessPolicyEntity['smrProvider'];
  private _smrModel?: IHarnessPolicyEntity['smrModel'];
  private _maxRegen: IHarnessPolicyEntity['maxRegen'];
  private _gateSlaSeconds: IHarnessPolicyEntity['gateSlaSeconds'];
  private _gateEscalationSeconds: IHarnessPolicyEntity['gateEscalationSeconds'];
  private _toolAllowlist?: IHarnessPolicyEntity['toolAllowlist'];
  private _optimisticDeliveryEnabled?: IHarnessPolicyEntity['optimisticDeliveryEnabled'];
  private _atomicFactEnabled?: IHarnessPolicyEntity['atomicFactEnabled'];
  private _retrievalEnabled?: IHarnessPolicyEntity['retrievalEnabled'];
  private _warmStartEnabled?: IHarnessPolicyEntity['warmStartEnabled'];
  private _nerPriorsEnabled?: IHarnessPolicyEntity['nerPriorsEnabled'];
  private _maxEditReruns?: IHarnessPolicyEntity['maxEditReruns'];
  private _regenFeedbackEnabled?: IHarnessPolicyEntity['regenFeedbackEnabled'];
  private _mcpToolsEnabled?: IHarnessPolicyEntity['mcpToolsEnabled'];

  constructor(init: IHarnessPolicyEntity) {
    super(init);
    this._entityFaithfulnessThreshold = init.entityFaithfulnessThreshold;
    this._coverageThreshold = init.coverageThreshold;
    this._citationPresenceThreshold = init.citationPresenceThreshold;
    this._numericDoseThreshold = init.numericDoseThreshold;
    this._groundednessThreshold = init.groundednessThreshold;
    this._safetyEnabled = init.safetyEnabled;
    this._phiEnabled = init.phiEnabled;
    this._phiFailClosed = init.phiFailClosed;
    this._safetyProvider = init.safetyProvider;
    this._safetyModel = init.safetyModel;
    this._smrProvider = init.smrProvider;
    this._smrModel = init.smrModel;
    this._maxRegen = init.maxRegen;
    this._gateSlaSeconds = init.gateSlaSeconds;
    this._gateEscalationSeconds = init.gateEscalationSeconds;
    this._toolAllowlist = init.toolAllowlist;
    this._optimisticDeliveryEnabled = init.optimisticDeliveryEnabled;
    this._atomicFactEnabled = init.atomicFactEnabled;
    this._retrievalEnabled = init.retrievalEnabled;
    this._warmStartEnabled = init.warmStartEnabled;
    this._nerPriorsEnabled = init.nerPriorsEnabled;
    this._maxEditReruns = init.maxEditReruns;
    this._regenFeedbackEnabled = init.regenFeedbackEnabled;
    this._mcpToolsEnabled = init.mcpToolsEnabled;
  }

  get entityFaithfulnessThreshold(): IHarnessPolicyEntity['entityFaithfulnessThreshold'] {
    return this._entityFaithfulnessThreshold;
  }

  set entityFaithfulnessThreshold(value: IHarnessPolicyEntity['entityFaithfulnessThreshold']) {
    this.setProperty('entityFaithfulnessThreshold', value);
  }

  get coverageThreshold(): IHarnessPolicyEntity['coverageThreshold'] {
    return this._coverageThreshold;
  }

  set coverageThreshold(value: IHarnessPolicyEntity['coverageThreshold']) {
    this.setProperty('coverageThreshold', value);
  }

  get citationPresenceThreshold(): IHarnessPolicyEntity['citationPresenceThreshold'] {
    return this._citationPresenceThreshold;
  }

  set citationPresenceThreshold(value: IHarnessPolicyEntity['citationPresenceThreshold']) {
    this.setProperty('citationPresenceThreshold', value);
  }

  get numericDoseThreshold(): IHarnessPolicyEntity['numericDoseThreshold'] {
    return this._numericDoseThreshold;
  }

  set numericDoseThreshold(value: IHarnessPolicyEntity['numericDoseThreshold']) {
    this.setProperty('numericDoseThreshold', value);
  }

  get groundednessThreshold(): IHarnessPolicyEntity['groundednessThreshold'] {
    return this._groundednessThreshold;
  }

  set groundednessThreshold(value: IHarnessPolicyEntity['groundednessThreshold']) {
    this.setProperty('groundednessThreshold', value);
  }

  get safetyEnabled(): IHarnessPolicyEntity['safetyEnabled'] {
    return this._safetyEnabled;
  }

  set safetyEnabled(value: IHarnessPolicyEntity['safetyEnabled']) {
    this.setProperty('safetyEnabled', value);
  }

  get phiEnabled(): IHarnessPolicyEntity['phiEnabled'] {
    return this._phiEnabled;
  }

  set phiEnabled(value: IHarnessPolicyEntity['phiEnabled']) {
    this.setProperty('phiEnabled', value);
  }

  get phiFailClosed(): IHarnessPolicyEntity['phiFailClosed'] {
    return this._phiFailClosed;
  }

  set phiFailClosed(value: IHarnessPolicyEntity['phiFailClosed']) {
    this.setProperty('phiFailClosed', value);
  }

  get safetyProvider(): IHarnessPolicyEntity['safetyProvider'] {
    return this._safetyProvider;
  }

  set safetyProvider(value: IHarnessPolicyEntity['safetyProvider']) {
    this.setProperty('safetyProvider', value);
  }

  get safetyModel(): IHarnessPolicyEntity['safetyModel'] {
    return this._safetyModel;
  }

  set safetyModel(value: IHarnessPolicyEntity['safetyModel']) {
    this.setProperty('safetyModel', value);
  }

  get smrProvider(): IHarnessPolicyEntity['smrProvider'] {
    return this._smrProvider;
  }

  set smrProvider(value: IHarnessPolicyEntity['smrProvider']) {
    this.setProperty('smrProvider', value);
  }

  get smrModel(): IHarnessPolicyEntity['smrModel'] {
    return this._smrModel;
  }

  set smrModel(value: IHarnessPolicyEntity['smrModel']) {
    this.setProperty('smrModel', value);
  }

  get maxRegen(): IHarnessPolicyEntity['maxRegen'] {
    return this._maxRegen;
  }

  set maxRegen(value: IHarnessPolicyEntity['maxRegen']) {
    this.setProperty('maxRegen', value);
  }

  get gateSlaSeconds(): IHarnessPolicyEntity['gateSlaSeconds'] {
    return this._gateSlaSeconds;
  }

  set gateSlaSeconds(value: IHarnessPolicyEntity['gateSlaSeconds']) {
    this.setProperty('gateSlaSeconds', value);
  }

  get gateEscalationSeconds(): IHarnessPolicyEntity['gateEscalationSeconds'] {
    return this._gateEscalationSeconds;
  }

  set gateEscalationSeconds(value: IHarnessPolicyEntity['gateEscalationSeconds']) {
    this.setProperty('gateEscalationSeconds', value);
  }

  get toolAllowlist(): IHarnessPolicyEntity['toolAllowlist'] {
    return this._toolAllowlist;
  }

  set toolAllowlist(value: IHarnessPolicyEntity['toolAllowlist']) {
    this.setProperty('toolAllowlist', value);
  }

  get optimisticDeliveryEnabled(): IHarnessPolicyEntity['optimisticDeliveryEnabled'] {
    return this._optimisticDeliveryEnabled;
  }

  set optimisticDeliveryEnabled(value: IHarnessPolicyEntity['optimisticDeliveryEnabled']) {
    this.setProperty('optimisticDeliveryEnabled', value);
  }

  get atomicFactEnabled(): IHarnessPolicyEntity['atomicFactEnabled'] {
    return this._atomicFactEnabled;
  }

  set atomicFactEnabled(value: IHarnessPolicyEntity['atomicFactEnabled']) {
    this.setProperty('atomicFactEnabled', value);
  }

  get retrievalEnabled(): IHarnessPolicyEntity['retrievalEnabled'] {
    return this._retrievalEnabled;
  }

  set retrievalEnabled(value: IHarnessPolicyEntity['retrievalEnabled']) {
    this.setProperty('retrievalEnabled', value);
  }

  get warmStartEnabled(): IHarnessPolicyEntity['warmStartEnabled'] {
    return this._warmStartEnabled;
  }

  set warmStartEnabled(value: IHarnessPolicyEntity['warmStartEnabled']) {
    this.setProperty('warmStartEnabled', value);
  }

  get nerPriorsEnabled(): IHarnessPolicyEntity['nerPriorsEnabled'] {
    return this._nerPriorsEnabled;
  }

  set nerPriorsEnabled(value: IHarnessPolicyEntity['nerPriorsEnabled']) {
    this.setProperty('nerPriorsEnabled', value);
  }

  get maxEditReruns(): IHarnessPolicyEntity['maxEditReruns'] {
    return this._maxEditReruns;
  }

  set maxEditReruns(value: IHarnessPolicyEntity['maxEditReruns']) {
    this.setProperty('maxEditReruns', value);
  }

  get regenFeedbackEnabled(): IHarnessPolicyEntity['regenFeedbackEnabled'] {
    return this._regenFeedbackEnabled;
  }

  set regenFeedbackEnabled(value: IHarnessPolicyEntity['regenFeedbackEnabled']) {
    this.setProperty('regenFeedbackEnabled', value);
  }

  get mcpToolsEnabled(): IHarnessPolicyEntity['mcpToolsEnabled'] {
    return this._mcpToolsEnabled;
  }

  set mcpToolsEnabled(value: IHarnessPolicyEntity['mcpToolsEnabled']) {
    this.setProperty('mcpToolsEnabled', value);
  }

  /**
   * Range-checks the safety-critical knobs (defense in depth — these values
   * drive the clinical gate). Thresholds are fractions in [0, 1]; the regen
   * budget and gate timers are non-negative integers. Subclass-mandated:
   * calls `super.validate()` so the tenant-context backstop still runs.
   */
  public override validate(): void {
    super.validate();
    this.assertFraction('entityFaithfulnessThreshold', this._entityFaithfulnessThreshold);
    this.assertFraction('coverageThreshold', this._coverageThreshold);
    this.assertFraction('citationPresenceThreshold', this._citationPresenceThreshold);
    this.assertFraction('numericDoseThreshold', this._numericDoseThreshold);
    this.assertFraction('groundednessThreshold', this._groundednessThreshold);

    this.assertNonNegativeInt('maxRegen', this._maxRegen);
    this.assertNonNegativeInt('gateSlaSeconds', this._gateSlaSeconds);
    this.assertNonNegativeInt('gateEscalationSeconds', this._gateEscalationSeconds);

    // the agentic knobs are nullable overrides; only range-check when set.
    if (this._maxEditReruns !== null && this._maxEditReruns !== undefined) {
      this.assertNonNegativeInt('maxEditReruns', this._maxEditReruns);
    }

    if (!this._safetyProvider || this._safetyProvider.trim().length === 0) {
      throw new BusinessException('HarnessPolicy safetyProvider is required.');
    }
    if (!this._safetyModel || this._safetyModel.trim().length === 0) {
      throw new BusinessException('HarnessPolicy safetyModel is required.');
    }
  }

  private assertFraction(field: string, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new BusinessException(`HarnessPolicy ${field} must be a number in [0, 1], got ${String(value)}.`);
    }
  }

  private assertNonNegativeInt(field: string, value: number): void {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new BusinessException(`HarnessPolicy ${field} must be a non-negative integer, got ${String(value)}.`);
    }
  }
}
