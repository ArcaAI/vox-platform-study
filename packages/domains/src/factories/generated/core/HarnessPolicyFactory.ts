/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { HarnessPolicyEntity, IHarnessPolicyEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * Defaults that mirror the harness runtime code defaults so a row created with
 * no explicit values is a faithful snapshot of the loop's built-in behaviour:
 *  - thresholds → apps/harness/src/harness/sensors/config.py (SensorThresholds)
 *  - safety/phi → apps/harness/src/harness/core/config.py (SafetyGuardConfig + PhiConfig)
 *  - regen/gate timing → apps/harness Settings (max_regen / gate_sla_seconds / gate_escalation_seconds)
 * Keep in lock-step with the Prisma column `@default`s in harness.prisma.
 */
export const HARNESS_POLICY_DEFAULTS = {
  entityFaithfulnessThreshold: 1.0,
  coverageThreshold: 0.8,
  citationPresenceThreshold: 1.0,
  numericDoseThreshold: 1.0,
  groundednessThreshold: 0.8,
  safetyEnabled: true,
  phiEnabled: true,
  phiFailClosed: true,
  safetyProvider: 'lm-studio',
  safetyModel: 'granite-guardian-4.1-8b',
  smrProvider: null as string | null,
  smrModel: null as string | null,
  maxRegen: 2,
  gateSlaSeconds: 86400,
  gateEscalationSeconds: 43200,
  toolAllowlist: null as IHarnessPolicyEntity['toolAllowlist'],
  // agentic loop knobs default to null so the harness
  // env/code default applies (per-field fallthrough). Only an explicit non-null
  // policy value overrides the runtime default.
  optimisticDeliveryEnabled: null as boolean | null,
  atomicFactEnabled: null as boolean | null,
  retrievalEnabled: null as boolean | null,
  warmStartEnabled: null as boolean | null,
  nerPriorsEnabled: null as boolean | null,
  maxEditReruns: null as number | null,
  regenFeedbackEnabled: null as boolean | null,
  // Per-tenant gate for the whole MCP external-tools path. null = OFF.
  mcpToolsEnabled: null as boolean | null,
} as const;

export interface CreateHarnessPolicyProps extends BaseEntityFactoryCreateProps {
  tenantId: IHarnessPolicyEntity['tenantId'];
  Tenant?: IHarnessPolicyEntity['Tenant'];

  entityFaithfulnessThreshold?: IHarnessPolicyEntity['entityFaithfulnessThreshold'];
  coverageThreshold?: IHarnessPolicyEntity['coverageThreshold'];
  citationPresenceThreshold?: IHarnessPolicyEntity['citationPresenceThreshold'];
  numericDoseThreshold?: IHarnessPolicyEntity['numericDoseThreshold'];
  groundednessThreshold?: IHarnessPolicyEntity['groundednessThreshold'];
  safetyEnabled?: IHarnessPolicyEntity['safetyEnabled'];
  phiEnabled?: IHarnessPolicyEntity['phiEnabled'];
  phiFailClosed?: IHarnessPolicyEntity['phiFailClosed'];
  safetyProvider?: IHarnessPolicyEntity['safetyProvider'];
  safetyModel?: IHarnessPolicyEntity['safetyModel'];
  smrProvider?: IHarnessPolicyEntity['smrProvider'];
  smrModel?: IHarnessPolicyEntity['smrModel'];
  maxRegen?: IHarnessPolicyEntity['maxRegen'];
  gateSlaSeconds?: IHarnessPolicyEntity['gateSlaSeconds'];
  gateEscalationSeconds?: IHarnessPolicyEntity['gateEscalationSeconds'];
  toolAllowlist?: IHarnessPolicyEntity['toolAllowlist'];
  optimisticDeliveryEnabled?: IHarnessPolicyEntity['optimisticDeliveryEnabled'];
  atomicFactEnabled?: IHarnessPolicyEntity['atomicFactEnabled'];
  retrievalEnabled?: IHarnessPolicyEntity['retrievalEnabled'];
  warmStartEnabled?: IHarnessPolicyEntity['warmStartEnabled'];
  nerPriorsEnabled?: IHarnessPolicyEntity['nerPriorsEnabled'];
  maxEditReruns?: IHarnessPolicyEntity['maxEditReruns'];
  regenFeedbackEnabled?: IHarnessPolicyEntity['regenFeedbackEnabled'];
  mcpToolsEnabled?: IHarnessPolicyEntity['mcpToolsEnabled'];

  createdAt?: IHarnessPolicyEntity['createdAt'];
  updatedAt?: IHarnessPolicyEntity['updatedAt'];
  createdBy?: IHarnessPolicyEntity['createdBy'];
  updatedBy?: IHarnessPolicyEntity['updatedBy'];
}

export class HarnessPolicyFactory {
  /**
   * Build a new policy row. Unspecified knobs fall back to the harness code
   * defaults (`HARNESS_POLICY_DEFAULTS`); callers that derive a tenant row from
   * the global default should pass the resolved values explicitly so the new
   * row inherits the platform default rather than the code default.
   */
  static CreateHarnessPolicy(props: CreateHarnessPolicyProps): HarnessPolicyEntity {
    const id = generateId();
    const now = new Date();
    const d = HARNESS_POLICY_DEFAULTS;

    return new HarnessPolicyEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      resourceStatus: props.resourceStatus,
      resourceStatusUpdatedAt: props.resourceStatusUpdatedAt,
      resourceStatusUpdatedBy: props.resourceStatusUpdatedBy,

      entityFaithfulnessThreshold: props.entityFaithfulnessThreshold ?? d.entityFaithfulnessThreshold,
      coverageThreshold: props.coverageThreshold ?? d.coverageThreshold,
      citationPresenceThreshold: props.citationPresenceThreshold ?? d.citationPresenceThreshold,
      numericDoseThreshold: props.numericDoseThreshold ?? d.numericDoseThreshold,
      groundednessThreshold: props.groundednessThreshold ?? d.groundednessThreshold,
      safetyEnabled: props.safetyEnabled ?? d.safetyEnabled,
      phiEnabled: props.phiEnabled ?? d.phiEnabled,
      phiFailClosed: props.phiFailClosed ?? d.phiFailClosed,
      safetyProvider: props.safetyProvider ?? d.safetyProvider,
      safetyModel: props.safetyModel ?? d.safetyModel,
      smrProvider: props.smrProvider ?? d.smrProvider,
      smrModel: props.smrModel ?? d.smrModel,
      maxRegen: props.maxRegen ?? d.maxRegen,
      gateSlaSeconds: props.gateSlaSeconds ?? d.gateSlaSeconds,
      gateEscalationSeconds: props.gateEscalationSeconds ?? d.gateEscalationSeconds,
      toolAllowlist: props.toolAllowlist ?? d.toolAllowlist,
      optimisticDeliveryEnabled: props.optimisticDeliveryEnabled ?? d.optimisticDeliveryEnabled,
      atomicFactEnabled: props.atomicFactEnabled ?? d.atomicFactEnabled,
      retrievalEnabled: props.retrievalEnabled ?? d.retrievalEnabled,
      warmStartEnabled: props.warmStartEnabled ?? d.warmStartEnabled,
      nerPriorsEnabled: props.nerPriorsEnabled ?? d.nerPriorsEnabled,
      maxEditReruns: props.maxEditReruns ?? d.maxEditReruns,
      regenFeedbackEnabled: props.regenFeedbackEnabled ?? d.regenFeedbackEnabled,
      mcpToolsEnabled: props.mcpToolsEnabled ?? d.mcpToolsEnabled,

      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
