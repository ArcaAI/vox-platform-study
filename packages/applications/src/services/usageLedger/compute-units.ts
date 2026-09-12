import Decimal from 'decimal.js';
import { AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import type { UsageEventBatchInput, UsageUnitInput } from './dto';
import type { ByteSource, ComputeDevice, UsageAttributes } from './usage-attributes';

/**
 * Compute seconds and third-party bytes, appended to a batch an emitter already
 * built (TASK-959 §3, §4, §6.3).
 *
 * ============================================================================
 * WHY ONE FUNCTION AND NOT A RULE IN EVERY EMITTER
 * ============================================================================
 * Eight emitters (TEXT sync, TEXT stream, the harness mapper, STT batch, STT
 * streaming, TTS, NLP, embeddings) all end up asking the same three questions
 * about the same numbers: which UNIT do these milliseconds become, does this
 * call's cost basis apply to them, and were the bytes actually observed. Each
 * answer is a price, so eight copies would be eight chances to price one wrong
 * and no single place to correct it.
 *
 * THE THREE RULES IT ENFORCES
 *
 *  1. **`device` decides the unit.** `cuda`/`mps` → `GPU_SECOND`, `cpu` →
 *     `CPU_SECOND`, and an UNRESOLVED device → `CPU_SECOND`. The two are priced
 *     an order of magnitude apart (~$1.98/GPU-hour against ~$0.036/vCPU-hour),
 *     so falling back to the cheaper unit is the only direction that
 *     under-records rather than over-charging a tenant for hardware it may not
 *     have occupied.
 *
 *  2. **A third-party call is metered on the PLATFORM's CPU.** `deployment`
 *     other than `SELF_HOSTED` means a vendor ran the model; what HOPE spent is
 *     the CPU of the service that made the call, which is always `cpu` whatever
 *     the caller resolved. §3.2's last row and the descriptor's own text both
 *     say so: "Cloud and BYOK calls ignore the map entirely."
 *
 *  3. **On a BYOK batch that CPU row is `INTERNAL`** (§6.3). The tenant paid
 *     its vendor for the tokens — those rows stay `BYOK_NOTIONAL` and
 *     contribute nothing to COGS — but the seconds HOPE burned making the call
 *     are platform cost. `costBasis` lives on `common`, so the only way to say
 *     two bases in one call is two batches: hence {@link ComputeAugmentedBatch}.
 *     `UsageLedgerService.warnOnInconsistentCostBasis` knows this exact shape
 *     and stays quiet for it; every OTHER BYOK+INTERNAL row still warns.
 *
 * BYTES STAY ON THE ORIGINATING BATCH, including a BYOK one. They are COST 0
 * today (no vendor and no tunnel bills HOPE per byte — D-3 records now, prices
 * later), so their basis moves no money; splitting them out would invent a
 * second platform row for a figure that is currently zero either way. Revisit
 * with D-3, not before.
 */

/**
 * The result of appending compute and byte rows.
 *
 * `platformBatch` is present ONLY for the sanctioned mixed-cost-basis case
 * (rule 3 above) and carries exactly one `CPU_SECOND` row. It deliberately
 * shares the caller's BASE idempotency key: expansion appends `:<UNIT>`, and
 * `CPU_SECOND` appears in exactly one of the two batches, so one base key
 * yields disjoint row keys and a redelivery still converges.
 *
 * A caller that records only `batch` loses the platform CPU leg of a BYOK call
 * — never a token, never a byte, and never anything that exists today.
 */
export interface ComputeAugmentedBatch {
  batch: UsageEventBatchInput;
  platformBatch?: UsageEventBatchInput;
}

/** What a calling emitter measured about one provider call. */
export interface ComputeAndByteMeasurements {
  /**
   * The device the SERVING engine ran on, for a self-hosted call. Resolved by
   * {@link IComputeDeviceResolver} for the LLM engines and reported directly by
   * stt/tts/nlp. Absent resolves to `cpu` — see rule 1.
   */
  device?: ComputeDevice | null;
  /** Client wall clock around the call, in milliseconds. */
  totalMs?: number | null;
  /** The engine's OWN reported time, when it reports one. Preferred over {@link totalMs}. */
  engineMs?: number | null;
  /** Bytes sent to the vendor. `null`/`0` = not observed. */
  requestBytes?: number | null;
  /** Bytes received from the vendor. `null`/`0` = not observed. */
  responseBytes?: number | null;
  /** Whether the byte counts are the wire or an application-level proxy. */
  byteSource?: ByteSource | null;
}

/** Occupancy seconds are recorded to the millisecond — three decimals, no more. */
const SECOND_DECIMALS = 3;

/**
 * Append the compute row and the two byte rows to `batch`, returning new
 * objects (the caller may legitimately build once and emit twice — the abort
 * and completion paths of a stream converge on one key — so mutating the input
 * would let the second emission inherit the first's rows).
 */
export function appendComputeAndByteUnits(batch: UsageEventBatchInput, measurements: ComputeAndByteMeasurements): ComputeAugmentedBatch {
  const selfHosted = batch.common.deployment === AiDeploymentKind.SELF_HOSTED;
  // Rule 2: a vendor's hardware is never billed as ours, whatever was resolved.
  const device: ComputeDevice = selfHosted ? (measurements.device ?? 'cpu') : 'cpu';
  const computeUnit = device === 'cpu' ? AiUsageUnit.CPU_SECOND : AiUsageUnit.GPU_SECOND;

  const seconds = toSeconds(measurements.engineMs ?? measurements.totalMs);
  const byteUnits = buildByteUnits(measurements);

  const units: UsageUnitInput[] = [...batch.units];
  const commonAttributes: UsageAttributes = { ...(batch.common.attributesJson ?? {}) };

  if (byteUnits.length > 0) {
    units.push(...byteUnits);
    // Recorded only alongside a real count: `byteSource` on a row with no byte
    // row would describe the honesty of a measurement nobody took.
    if (measurements.byteSource) commonAttributes.byteSource = measurements.byteSource;
  }

  // Rule 3 — does the compute row's basis differ from the batch's?
  const splitRequired = seconds !== null && batch.common.deployment === AiDeploymentKind.BYOK && effectiveBasis(batch) !== AiCostBasis.INTERNAL;

  if (seconds !== null && !splitRequired) {
    units.push({ unit: computeUnit, quantity: seconds });
    commonAttributes.device = device;
  }

  const result: ComputeAugmentedBatch = {
    batch: { common: { ...batch.common, attributesJson: commonAttributes }, units },
  };

  if (seconds !== null && splitRequired) {
    result.platformBatch = {
      common: {
        ...batch.common,
        // The platform's own CPU, on a call the TENANT funded. Deployment stays
        // BYOK — that is a fact about the call, not about who paid for these
        // seconds — and the basis is what makes them COGS.
        costBasis: AiCostBasis.INTERNAL,
        attributesJson: { ...commonAttributes, device },
      },
      units: [{ unit: computeUnit, quantity: seconds }],
    };
  }

  return result;
}

/** `INTERNAL` is the contract's default when an emitter omits the field. */
function effectiveBasis(batch: UsageEventBatchInput): AiCostBasis {
  return batch.common.costBasis ?? AiCostBasis.INTERNAL;
}

/**
 * Milliseconds → a fixed-3dp second string, or `null` when nothing was measured.
 *
 * A STRING because a JSON number is an IEEE double and fractional seconds
 * multiplied by a price is exactly where float drift becomes money — the same
 * reason `serializeUsageEvent` stringifies every quantity.
 *
 * A non-positive or non-finite reading is "not measured", not "zero seconds":
 * emitting it would add a row saying nothing happened to every call whose
 * service predates the field.
 */
function toSeconds(milliseconds: number | null | undefined): string | null {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  return new Decimal(milliseconds).div(1000).toFixed(SECOND_DECIMALS);
}

/**
 * The two direction rows.
 *
 * Bytes are whole counts, so they stay numbers. A reported `0` is dropped: no
 * adapter sends an empty request body, so a zero is an adapter that measured
 * nothing, and the batch expansion would drop the row anyway.
 */
function buildByteUnits(measurements: ComputeAndByteMeasurements): UsageUnitInput[] {
  const units: UsageUnitInput[] = [];
  const egress = toByteCount(measurements.requestBytes);
  const ingress = toByteCount(measurements.responseBytes);
  if (egress !== null) units.push({ unit: AiUsageUnit.EGRESS_BYTE, quantity: egress });
  if (ingress !== null) units.push({ unit: AiUsageUnit.INGRESS_BYTE, quantity: ingress });
  return units;
}

function toByteCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}
