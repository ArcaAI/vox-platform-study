import Decimal from 'decimal.js';
import { AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import type { UsageEventBatchInput, UsageUnitInput } from './dto';
import { BYTE_SOURCES, COMPUTE_DEVICES, type ByteSource, type ComputeDevice } from './usage-attributes';

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
 * and no single place to correct it. Three copies actually existed for one wave
 * (this module, `apps/api/src/modules/agent/compute-units.ts`,
 * `services/stt/internal/compute-network-units.ts`); they disagreed about the
 * quantity type, about where `device` rides, and about when a batch splits, and
 * on the one path that used two of them at once every compute and byte row was
 * emitted TWICE. This is the only one left.
 *
 * ============================================================================
 * THE RULE THAT KEEPS A ROW FROM BEING BILLED TWICE
 * ============================================================================
 * **Whoever BUILDS the batch appends. Never append to a batch someone else
 * built.** `common` plus the token / audio / character rows and the compute and
 * byte rows are one decision made in one place:
 *
 *  · `text-usage.ts`'s three builders append (so do their `*Batches` siblings —
 *    the single-batch forms differ ONLY in dropping `platformBatch`), and
 *    `LlmStreamUsageCollector` appends through them. A caller that received a
 *    batch from any of those already HAS its compute and byte rows.
 *  · An emitter that hand-builds its own `{common, units}` — `nerUsageEvent.ts`,
 *    the two STT emitters, the agent route's TTS relay, `harness-usage.mapper.ts`
 *    — calls this itself, once, on the batch it just built.
 *
 * ============================================================================
 * THE FOUR RULES IT ENFORCES
 * ============================================================================
 *  1. **`device` decides the unit.** `cuda`/`mps` → `GPU_SECOND`, `cpu` →
 *     `CPU_SECOND`. They are priced an order of magnitude apart (~$1.98/GPU-hour
 *     against ~$0.036/vCPU-hour), which is why an absent — or unrecognised —
 *     device on a SELF_HOSTED call records NO compute row at all. Nothing here
 *     guesses: "never nothing" is the DEVICE RESOLVER's job
 *     ({@link IComputeDeviceResolver}, whose unlisted-provider answer is `cpu`)
 *     for the LLM engines, and the wire's for stt/tts/nlp. A caller that
 *     resolved nothing measured nothing, and under-recording is the correctable
 *     direction — a fabricated GPU-hour on a CPU call is an invoice nobody can
 *     defend.
 *
 *  2. **A third-party call is metered on the PLATFORM's CPU.** `deployment`
 *     other than `SELF_HOSTED` means a vendor ran the model; what HOPE spent is
 *     the CPU of the service that made the call, which is `cpu` whatever the
 *     caller resolved or the wire reported. §3.2's last row and the descriptor's
 *     own text both say so: "Cloud and BYOK calls ignore the map entirely."
 *
 *  3. **On a `BYOK_NOTIONAL` batch that compute row is `INTERNAL`** (§6.3). The
 *     tenant paid its vendor for the tokens — those rows stay `BYOK_NOTIONAL`
 *     and contribute nothing to COGS — but the seconds HOPE burned making the
 *     call are platform cost. `costBasis` lives on `common`, so the only way to
 *     say two bases in one call is two batches: hence
 *     {@link ComputeAugmentedBatch}. A CLOUD batch needs no split — it is
 *     already `INTERNAL`. `UsageLedgerService.warnOnInconsistentCostBasis` knows
 *     this exact shape and stays quiet for it; every OTHER BYOK+INTERNAL row
 *     still warns.
 *
 *  4. **`device` and `byteSource` ride the UNIT ROW, never `common`.** The
 *     token / audio-second / character rows an emitter already wrote are
 *     unchanged by this ticket, down to their attribute bag; a key on `common`
 *     would be merged onto every one of them at expansion and would describe
 *     rows it says nothing about. (`expandUsageBatch` merges the per-unit bag
 *     OVER the common one, so the allow-list still sees both together.)
 *
 * BYTES STAY ON THE ORIGINATING BATCH, including a BYOK one. They are COST 0
 * today (no vendor and no tunnel bills HOPE per byte — D-3 records now, prices
 * later), so their basis moves no money; splitting them out would invent a
 * second platform row for a figure that is currently zero either way. Revisit
 * with D-3, not before.
 *
 * QUANTITIES ARE DECIMAL STRINGS. `quantity` is `number | string` and the
 * contract asks for a string when fractional, because a JSON number is an IEEE
 * double and fractional seconds multiplied by a price is exactly where float
 * drift becomes money. Every quantity this function emits is a string — seconds
 * at three decimals, bytes as whole counts — so no call site has to remember
 * which of its rows was the fractional one.
 */

/**
 * The result of appending compute and byte rows.
 *
 * `platformBatch` is present ONLY for the sanctioned mixed-cost-basis case
 * (rule 3 above) and carries exactly one compute row. It deliberately shares the
 * caller's BASE idempotency key: expansion appends `:<UNIT>`, and that unit
 * appears in exactly one of the two batches, so one base key yields disjoint row
 * keys and a redelivery still converges.
 *
 * A caller that records only `batch` loses the platform compute leg of a BYOK
 * call — never a token, never a byte, and never anything that exists today.
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
   * stt/tts/nlp. Typed as a plain string because two of those paths are read off
   * an UNVALIDATED wire body (the STT teardown `DELETE` response has no
   * `ValidationPipe` in front of it): membership in {@link COMPUTE_DEVICES} is
   * checked here, and anything else is treated as absent — see rule 1.
   */
  device?: ComputeDevice | string | null;
  /** Client wall clock around the call, in milliseconds. */
  totalMs?: number | null;
  /** The engine's OWN reported time, when it reports one. Preferred over {@link totalMs}. */
  engineMs?: number | null;
  /**
   * Occupancy in SECONDS, for the services that report it that way (STT's
   * `processing_seconds` / `processingTimeSeconds`). Used only when neither
   * millisecond reading is present — one call is timed once, by whoever timed it.
   */
  seconds?: number | null;
  /** Bytes sent to the vendor. `null`/`0` = not observed. */
  requestBytes?: number | null;
  /** Bytes received from the vendor. `null`/`0` = not observed. */
  responseBytes?: number | null;
  /**
   * Whether the byte counts are the wire or an application-level proxy. Same
   * unvalidated-wire reasoning as {@link device}; an unrecognised value is
   * dropped rather than stamped.
   */
  byteSource?: ByteSource | string | null;
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
  const computeUnit = buildComputeUnit(batch, measurements);
  const byteUnits = buildByteUnits(measurements);

  // Rule 3 — does the compute row's basis differ from the batch it belongs to?
  const splitsBasis = computeUnit !== null && batch.common.costBasis === AiCostBasis.BYOK_NOTIONAL;

  const units: UsageUnitInput[] = [...batch.units];
  if (computeUnit && !splitsBasis) units.push(computeUnit);
  units.push(...byteUnits);

  const result: ComputeAugmentedBatch = { batch: { ...batch, units } };

  if (computeUnit && splitsBasis) {
    result.platformBatch = {
      common: {
        ...batch.common,
        // The platform's own CPU, on a call the TENANT funded. Deployment stays
        // BYOK — that is a fact about the call, not about who paid for these
        // seconds — and the basis is what makes them COGS.
        costBasis: AiCostBasis.INTERNAL,
      },
      units: [computeUnit],
    };
  }

  return result;
}

/** The one compute row, or `null` when nothing priceable was measured (rules 1 + 2). */
function buildComputeUnit(batch: UsageEventBatchInput, measurements: ComputeAndByteMeasurements): UsageUnitInput | null {
  const quantity = occupancySeconds(measurements);
  if (quantity === null) return null;

  const device = resolveDevice(batch.common.deployment, measurements.device);
  if (device === null) return null;

  return {
    unit: device === 'cpu' ? AiUsageUnit.CPU_SECOND : AiUsageUnit.GPU_SECOND,
    quantity,
    attributesJson: { device },
  };
}

/**
 * Which device these seconds were spent on — `null` meaning "no row".
 *
 * A vendor's hardware is never billed as ours (rule 2), and a self-hosted call
 * whose device nobody resolved is not guessed at (rule 1).
 */
function resolveDevice(deployment: AiDeploymentKind, reported: ComputeDevice | string | null | undefined): ComputeDevice | null {
  if (deployment !== AiDeploymentKind.SELF_HOSTED) return 'cpu';
  return typeof reported === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(reported) ? (reported as ComputeDevice) : null;
}

/**
 * The occupancy reading, as a fixed-3dp second string, or `null` when nothing
 * was measured.
 *
 * PRECEDENCE: the engine's own time, then the client's wall clock, then a
 * caller that measured in seconds to begin with. `engine_ms` is what llama.cpp
 * and Ollama report about their own decode loops; `total_ms` also contains the
 * network, so preferring the engine keeps the second closer to what the tenant
 * actually held the model for.
 *
 * A non-positive or non-finite reading is "not measured", not "zero seconds":
 * emitting it would add a row saying nothing happened to every call whose
 * service predates the field, and a sub-microsecond reading that ROUNDS to zero
 * is the same non-event.
 */
function occupancySeconds(measurements: ComputeAndByteMeasurements): string | null {
  const milliseconds = firstPositive(measurements.engineMs, measurements.totalMs);
  const seconds = milliseconds === null ? firstPositive(measurements.seconds) : new Decimal(milliseconds).div(1000);
  if (seconds === null) return null;

  const fixed = seconds.toFixed(SECOND_DECIMALS);
  return new Decimal(fixed).isZero() ? null : fixed;
}

/** The first reading that is a real positive measurement, as a `Decimal`. */
function firstPositive(...values: (number | null | undefined)[]): Decimal | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Decimal(value);
  }
  return null;
}

/**
 * The two direction rows.
 *
 * A reported `0` is dropped: no adapter sends an empty request body, so a zero
 * is an adapter that measured nothing, and the batch expansion would drop the
 * row anyway. `byteSource` is recorded only alongside a real count — on a row
 * with no byte row it would describe the honesty of a measurement nobody took.
 */
function buildByteUnits(measurements: ComputeAndByteMeasurements): UsageUnitInput[] {
  const units: UsageUnitInput[] = [];
  const egress = toByteCount(measurements.requestBytes);
  const ingress = toByteCount(measurements.responseBytes);
  if (egress === null && ingress === null) return units;

  const byteSource = asByteSource(measurements.byteSource);
  const attributes = byteSource === null ? {} : { attributesJson: { byteSource } };
  if (egress !== null) units.push({ unit: AiUsageUnit.EGRESS_BYTE, quantity: egress, ...attributes });
  if (ingress !== null) units.push({ unit: AiUsageUnit.INGRESS_BYTE, quantity: ingress, ...attributes });
  return units;
}

/** Bytes are whole counts — a string like every other quantity here. */
function toByteCount(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return new Decimal(value).toFixed(0);
}

function asByteSource(value: ByteSource | string | null | undefined): ByteSource | null {
  return typeof value === 'string' && (BYTE_SOURCES as readonly string[]).includes(value) ? (value as ByteSource) : null;
}
