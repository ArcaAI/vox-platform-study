// TASK-959 T1-merge: replace with `appendComputeAndByteUnits` from
// `packages/applications/src/services/usageLedger/compute-units.ts`.
//
// ============================================================================
// WHY THIS FILE EXISTS AT ALL
// ============================================================================
// Lane T1 owns `usageLedger/**` and is building the shared helper this module
// duplicates, in the same wave. This lane cannot import it yet and must not
// write into that directory, so the append rules live here — in the agent
// module that consumes them — until the merge, at which point every call site
// below swaps to the shared export and this file is DELETED. The rules are the
// contract's (§10.2), not this lane's invention, so the swap is an import
// change rather than a behaviour change.
//
// ============================================================================
// THE RULES, AND WHY EACH ONE REFUSES TO GUESS
// ============================================================================
//  · The DEVICE decides the unit: `cuda`/`mps` → `GPU_SECOND`, `cpu` →
//    `CPU_SECOND`. They are priced an order of magnitude apart, so an unknown
//    device records NO compute row. Under-recording is correctable from the
//    consumption screen with a compensating event; a fabricated GPU-hour on a
//    CPU call is an invoice nobody can defend.
//  · Quantity is OCCUPANCY seconds (§3.1) at 3 decimal places — millisecond
//    resolution, which is what every service measures. A reading that rounds to
//    zero records nothing rather than a row saying nothing happened.
//  · Bytes are two UNITS, not one unit with a direction attribute, so direction
//    stays a dimension of the row the rollups already group by. `null` means
//    "not counted" and is not the same fact as `0`; both produce no row, but
//    only the second is a measurement.
//  · A batch carries ONE `costBasis`. On a BYOK call the tokens are the
//    tenant's money and the CPU seconds spent CALLING the vendor are the
//    platform's, so that row leaves as a SECOND batch at `INTERNAL` sharing the
//    base idempotency key (expansion appends `:<UNIT>`, so the keys cannot
//    collide). This is the single sanctioned mixed-basis case in the contract.

import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import type { ByteSource, ComputeDevice, UsageEventBatchInput, UsageUnitInput } from '@arcaai/applications';

/** What a serving service reported about the call a batch already describes. */
export interface ComputeAndByteSample {
  /** `null` = the server named no device we know. No compute row is recorded. */
  device: ComputeDevice | null;
  /** Occupancy seconds — engine time when the engine reports one, else wall clock. */
  seconds: number | null;
  /** Bytes SENT to the vendor. `null` = not counted (an adapter off the instrumented transport). */
  requestBytes?: number | null;
  /** Bytes RECEIVED from the vendor. */
  responseBytes?: number | null;
  /** `wire` = counted at the transport; `app` = an application-level proxy. Omitted when unstated. */
  byteSource?: ByteSource | null;
}

/** Millisecond resolution, the grain every service actually measures. */
function toSeconds(seconds: number | null | undefined): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds * 1000) / 1000;
  return rounded > 0 ? rounded : null;
}

function toByteCount(bytes: number | null | undefined): number | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes);
}

function computeUnitFor(device: ComputeDevice): AiUsageUnit {
  return device === 'cpu' ? AiUsageUnit.CPU_SECOND : AiUsageUnit.GPU_SECOND;
}

/**
 * Append the compute and byte rows a call produced to the batch it already produces.
 *
 * @returns the batches to record: `[]` for a null batch, `[batch]` when there was nothing to
 *          append, `[batch]` with the extra unit rows, or `[batch, cpuOnlyBatch]` for the BYOK
 *          mixed-basis split. Never mutates its input — an abort path may legitimately build
 *          once and emit twice.
 */
export function appendComputeAndByteUnits(batch: UsageEventBatchInput | null, sample: ComputeAndByteSample): UsageEventBatchInput[] {
  if (!batch) return [];

  const seconds = toSeconds(sample.seconds);
  const device = sample.device;
  const computeUnit: UsageUnitInput | null =
    device && seconds !== null ? { unit: computeUnitFor(device), quantity: seconds, attributesJson: { device } } : null;

  const byteAttributes = sample.byteSource ? { attributesJson: { byteSource: sample.byteSource } } : {};
  const byteUnits: UsageUnitInput[] = [];
  const requestBytes = toByteCount(sample.requestBytes);
  const responseBytes = toByteCount(sample.responseBytes);
  if (requestBytes !== null) byteUnits.push({ unit: AiUsageUnit.EGRESS_BYTE, quantity: requestBytes, ...byteAttributes });
  if (responseBytes !== null) byteUnits.push({ unit: AiUsageUnit.INGRESS_BYTE, quantity: responseBytes, ...byteAttributes });

  if (!computeUnit && byteUnits.length === 0) return [batch];

  // The one place the basis can differ from the batch it belongs to.
  const splitsBasis = computeUnit?.unit === AiUsageUnit.CPU_SECOND && batch.common.costBasis === AiCostBasis.BYOK_NOTIONAL;

  const primary: UsageEventBatchInput = {
    ...batch,
    units: [...batch.units, ...byteUnits, ...(computeUnit && !splitsBasis ? [computeUnit] : [])],
  };

  if (!splitsBasis || !computeUnit) return [primary];

  return [
    primary,
    {
      // SAME call: same key base, same request id, same provider, same deployment. Only the
      // basis differs, because only the funding does.
      common: { ...batch.common, costBasis: AiCostBasis.INTERNAL },
      units: [computeUnit],
    },
  ];
}
