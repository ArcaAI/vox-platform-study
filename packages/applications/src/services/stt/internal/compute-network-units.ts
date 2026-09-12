import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';

import type { UsageUnitInput } from '../../usageLedger/dto';
import { BYTE_SOURCES, COMPUTE_DEVICES, type ByteSource, type ComputeDevice } from '../../usageLedger/usage-attributes';

/**
 * TASK-959 — the compute and network unit rows an STT call adds to the batch it
 * already writes.
 *
 * TASK-959 T1-merge: replace with `appendComputeAndByteUnits`. This is the T1
 * contract implemented locally so the STT lane does not block on the shared
 * builder landing; the RULES below are T1's, not this file's, and when T1 merges
 * this module is deleted and its two call sites re-pointed. Nothing outside
 * `services/stt/**` may import it — it is deliberately absent from the barrel.
 *
 * Three rules, all of them decisions someone can be wrong about:
 *
 * 1. **The DEVICE decides the unit, and it arrives ON THE WIRE.** `cuda`/`mps`
 *    make the occupancy seconds a `GPU_SECOND`, `cpu` a `CPU_SECOND`, and the
 *    two are priced an order of magnitude apart. The serving worker reports it
 *    (`LoadedModel.device`, per segment for a stream); there is no descriptor
 *    lookup on this path and no default. An absent — or unrecognised — device
 *    emits NO compute row, because the alternative is billing a GPU second at a
 *    CPU rate or the reverse, silently.
 *
 * 2. **Zero is not a row.** `expandUsageBatch` drops zero-quantity units, so a
 *    `0` here would be dropped downstream anyway; filtering at the source keeps
 *    the emitted batch honest about what it actually contains. Byte counts
 *    arrive `null` (self-hosted: no third-party call was made) or `0` (a real
 *    measurement); neither becomes a row, and the DIFFERENCE between them is
 *    carried by `byteSource`, not by a zero-quantity row nobody can price.
 *
 * 3. **A CPU second on a BYOK call is the PLATFORM's cost.** The tenant's own
 *    key paid the vendor, but the CPU this service burned calling it is real
 *    platform spend — so that one row is `INTERNAL` while its siblings stay
 *    `BYOK_NOTIONAL`. `costBasis` lives on `common`, so two bases means two
 *    batches; they share the base idempotency key and `expandUsageBatch` keeps
 *    the rows distinct by appending `:<UNIT>`. This is the ONE sanctioned
 *    mixed-basis case in the ledger (§10.2) — bytes are NOT split, they are the
 *    vendor call's own traffic and stay on the vendor call's basis.
 */
export interface ComputeAndByteMeasurement {
  /** Wall-clock occupancy on the model — `processingTimeSeconds` / `processing_seconds`. */
  processingSeconds?: number | null;
  /** `cuda` | `mps` | `cpu`, as REPORTED. Anything else is treated as absent. */
  device?: string | null;
  requestBytes?: number | null;
  responseBytes?: number | null;
  byteSource?: string | null;
}

export interface ComputeAndByteUnits {
  /** Append to the call's own batch — these carry its cost basis. */
  onCallBasis: UsageUnitInput[];
  /** Emit as a SECOND batch on the same base key when non-empty (rule 3). */
  onInternalBasis: UsageUnitInput[];
}

/** Occupancy seconds at millisecond resolution — a float artefact is not a measurement. */
const SECONDS_PRECISION = 3;

const isPositiveFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

const asComputeDevice = (value: unknown): ComputeDevice | null =>
  typeof value === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(value) ? (value as ComputeDevice) : null;

const asByteSource = (value: unknown): ByteSource | null =>
  typeof value === 'string' && (BYTE_SOURCES as readonly string[]).includes(value) ? (value as ByteSource) : null;

/**
 * Build the compute and byte unit lines for one call.
 *
 * @param callCostBasis the basis the call's OWN batch carries. `undefined` is
 *        `INTERNAL` (what `serializeUsageEvent` defaults to), so it needs no
 *        split — only an explicitly non-`INTERNAL` basis does.
 */
export function computeAndByteUnits(measurement: ComputeAndByteMeasurement, callCostBasis?: AiCostBasis): ComputeAndByteUnits {
  const onCallBasis: UsageUnitInput[] = [];
  const onInternalBasis: UsageUnitInput[] = [];

  const device = asComputeDevice(measurement.device);
  if (device !== null && isPositiveFinite(measurement.processingSeconds)) {
    const computeRow: UsageUnitInput = {
      unit: device === 'cpu' ? AiUsageUnit.CPU_SECOND : AiUsageUnit.GPU_SECOND,
      quantity: Number(measurement.processingSeconds.toFixed(SECONDS_PRECISION)),
      // Per-UNIT, not on `common`: the audio/session rows this batch already
      // carried are unchanged by this ticket, down to their attribute bag.
      attributesJson: { device },
    };
    (callCostBasis !== undefined && callCostBasis !== AiCostBasis.INTERNAL ? onInternalBasis : onCallBasis).push(computeRow);
  }

  const byteSource = asByteSource(measurement.byteSource);
  const byteAttributes = byteSource !== null ? { attributesJson: { byteSource } } : {};

  if (isPositiveFinite(measurement.requestBytes)) {
    onCallBasis.push({ unit: AiUsageUnit.EGRESS_BYTE, quantity: measurement.requestBytes, ...byteAttributes });
  }
  if (isPositiveFinite(measurement.responseBytes)) {
    onCallBasis.push({ unit: AiUsageUnit.INGRESS_BYTE, quantity: measurement.responseBytes, ...byteAttributes });
  }

  return { onCallBasis, onInternalBasis };
}
