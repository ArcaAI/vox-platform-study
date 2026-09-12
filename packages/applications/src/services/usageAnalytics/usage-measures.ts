import Decimal from 'decimal.js';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { UsageComputeSeconds, UsageThirdPartyBytes } from './dto';

/** Matches `UsageSummaryLine.quantity` and the ledger's own `Decimal(_,6)` columns. */
export const QUANTITY_DECIMAL_PLACES = 6;

/**
 * The capabilities whose occupancy seconds are INFERENCE compute.
 *
 * Defined as the COMPLEMENT of the two non-inference capabilities rather than
 * as a list of the five that exist today, so a capability added later is
 * counted without anyone remembering to edit this line. The two exclusions are
 * the deliberate part:
 *
 *   - `WORKFLOW` is the durable worker's own CPU. It has its own capability
 *     precisely so it can have its own allowance and its own invoice line
 *     (§3.4); folding it into the inference figure would bill it twice.
 *   - `STORAGE` carries no seconds at all — its unit is the GB-day.
 */
const NON_INFERENCE_CAPABILITIES: ReadonlySet<AiCapability> = new Set([AiCapability.WORKFLOW, AiCapability.STORAGE]);

/**
 * The deployments whose byte rows crossed to a THIRD PARTY.
 *
 * `SELF_HOSTED` bytes are recorded too — the pool transport sees LM Studio
 * traffic for free — but LAN traffic to a server the platform runs is not
 * third-party consumption, and it is voluminous enough to swamp the figure it
 * would be added to.
 */
const THIRD_PARTY_DEPLOYMENTS: ReadonlySet<AiDeploymentKind> = new Set([AiDeploymentKind.CLOUD, AiDeploymentKind.BYOK]);

/** The dimensions of a rollup bucket this module actually reads. */
export interface MeasurableRollup {
  capability: AiCapability;
  deployment?: AiDeploymentKind;
  unit: AiUsageUnit;
  quantitySum: Decimal.Value;
}

export interface UsageMeasures {
  computeSeconds: UsageComputeSeconds;
  workflowCpuSeconds: string;
  thirdPartyBytes: UsageThirdPartyBytes;
  /** Σ STORAGE_GB_DAY across every class, or `null` when these rows carry no snapshot at all. */
  storageGb: string | null;
}

/**
 * Reduce a set of rollup buckets to the four TASK-959 figures.
 *
 * Pure, and deliberately takes the rows the caller has ALREADY read: both the
 * summary and the timeseries fetch a period's buckets for their own reasons, so
 * deriving these here costs no query. It never inspects `provider`, `model` or
 * `operation` — every one of these figures is a question about (capability,
 * deployment, unit), which is exactly what the rollup grain preserves.
 */
export function summariseMeasures(rollups: readonly MeasurableRollup[]): UsageMeasures {
  let gpu = new Decimal(0);
  let cpu = new Decimal(0);
  let workflowCpu = new Decimal(0);
  let egress = new Decimal(0);
  let ingress = new Decimal(0);
  let storage: Decimal | null = null;

  for (const rollup of rollups) {
    const quantity = new Decimal(String(rollup.quantitySum));
    const isInference = !NON_INFERENCE_CAPABILITIES.has(rollup.capability);

    switch (rollup.unit) {
      case AiUsageUnit.GPU_SECOND:
        if (isInference) gpu = gpu.plus(quantity);
        break;
      case AiUsageUnit.CPU_SECOND:
        if (rollup.capability === AiCapability.WORKFLOW) workflowCpu = workflowCpu.plus(quantity);
        else if (isInference) cpu = cpu.plus(quantity);
        break;
      case AiUsageUnit.EGRESS_BYTE:
        if (isThirdParty(rollup.deployment)) egress = egress.plus(quantity);
        break;
      case AiUsageUnit.INGRESS_BYTE:
        if (isThirdParty(rollup.deployment)) ingress = ingress.plus(quantity);
        break;
      case AiUsageUnit.STORAGE_GB_DAY:
        // Seeded to zero on the FIRST snapshot row seen, so "no snapshot in
        // these buckets" stays distinguishable from "a snapshot of nothing".
        storage = (storage ?? new Decimal(0)).plus(quantity);
        break;
      default:
        break;
    }
  }

  return {
    computeSeconds: { gpuSeconds: gpu.toFixed(QUANTITY_DECIMAL_PLACES), cpuSeconds: cpu.toFixed(QUANTITY_DECIMAL_PLACES) },
    workflowCpuSeconds: workflowCpu.toFixed(QUANTITY_DECIMAL_PLACES),
    thirdPartyBytes: { egressBytes: egress.toFixed(QUANTITY_DECIMAL_PLACES), ingressBytes: ingress.toFixed(QUANTITY_DECIMAL_PLACES) },
    storageGb: storage === null ? null : storage.toFixed(QUANTITY_DECIMAL_PLACES),
  };
}

/**
 * An ABSENT deployment is SELF_HOSTED, matching the column default — so it is
 * not third-party. Erring the other way would attribute a platform-internal
 * call to a vendor.
 */
function isThirdParty(deployment: AiDeploymentKind | undefined): boolean {
  return deployment !== undefined && THIRD_PARTY_DEPLOYMENTS.has(deployment);
}
