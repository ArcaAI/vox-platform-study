/**
 * TASK-959 W0 — COST coverage for the compute / network / storage units, and
 * the SELL-side gate that must stay closed.
 *
 * Static assertions over the EXPORTED seed rows (no live DB), following
 * `managed-asr-addon-posture.test.ts` in this directory.
 *
 * ============================================================================
 * WHY CAPABILITY COVERAGE IS THE THING UNDER TEST
 * ============================================================================
 * `AiPriceBookRepository.findEffectiveCandidates` filters on `capability` with
 * an EXACT equality — it is part of the SQL `where`, not one of the wildcard
 * dimensions `selectMostSpecificPrice` resolves. `AiUsageEvent.capability` is
 * NOT NULL. So a `USAGE_UNIT` row with `capability: null` can never be
 * resolved by the at-ingest rater: it is a dead row that LOOKS like coverage.
 *
 * That is the failure these tests exist to catch, because it is silent in
 * exactly the wrong way — the event still appends (the drainer rates
 * best-effort), so nothing errors; the row simply carries `costMicros: null`
 * forever and the platform's COGS for that unit reads as zero rather than
 * unknown. One row per (unit, emitting capability) is therefore the contract,
 * not one row per unit.
 *
 * ============================================================================
 * AND WHY THERE MUST BE NO SELL ROW
 * ============================================================================
 * The gate runs the other way on the SELL plane: `BillingService` THROWS
 * `MissingSellRateError` (→ 409) on a billable unit with no SELL rate, and it
 * throws for the whole draft, not the one line. Until wave 4 ships the SELL
 * rows, the allowance columns and the `BILLABLE_UNITS` entries together, a SELL
 * row here would be the first half of a three-part change — which is the shape
 * that breaks invoicing for every tenant.
 */

import { describe, it, expect } from 'vitest';

import { AiCapability, AiPriceBookPlane, AiPriceRowKind, AiUsageUnit } from '../../../../generated/core-prisma-client/client.js';
import { PRICE_BOOK_SEED_ROWS } from '../20-ai-price-book';

/** The four units TASK-959 introduced, plus the one it finally prices per provider. */
const NEW_UNITS = [AiUsageUnit.CPU_SECOND, AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE, AiUsageUnit.STORAGE_GB_DAY] as const;

const costRows = PRICE_BOOK_SEED_ROWS.filter((row) => row.plane === AiPriceBookPlane.COST);
const sellRows = PRICE_BOOK_SEED_ROWS.filter((row) => row.plane === AiPriceBookPlane.SELL);

const costRowsFor = (unit: AiUsageUnit) => costRows.filter((row) => row.unit === unit);

describe('CPU_SECOND — every capability that can emit occupancy on a CPU device has a rate', () => {
  // §3.2: STT on a CPU engine, NLP (GLiNER on CPU), TTS (settings default
  // `cpu`), EMBEDDING (the TEI CPU image), and LLM — where the seconds are not
  // inference at all but "CPU time spent CALLING a third-party provider"
  // (M-3), which is why a BYOK batch carries a CPU_SECOND row at
  // `costBasis: INTERNAL`.
  const EMITTING = [AiCapability.STT, AiCapability.LLM, AiCapability.NLP, AiCapability.TTS, AiCapability.EMBEDDING];

  it.each(EMITTING)('prices CPU_SECOND for %s with a provider-wildcard row', (capability) => {
    const rows = costRowsFor(AiUsageUnit.CPU_SECOND).filter((row) => row.capability === capability && (row.provider ?? null) === null);
    expect(rows, `no provider-wildcard CPU_SECOND COST row for ${capability} — its rows would drain UNRATED`).toHaveLength(1);
    expect(rows[0]!.unitPriceMicros).toBeGreaterThan(0n);
  });

  it('prices the durable worker separately, keyed on provider `harness` under capability WORKFLOW', () => {
    const rows = costRowsFor(AiUsageUnit.CPU_SECOND).filter((row) => row.capability === AiCapability.WORKFLOW);
    expect(rows).toHaveLength(1);
    // Provider-keyed on purpose: `harness` is a CPU node, not a GPU one, and a
    // provider-wildcard row would let a future engine inherit a worker rate.
    expect(rows[0]!.provider).toBe('harness');
    expect(rows[0]!.unitPriceMicros).toBeGreaterThan(0n);
  });

  it('declares no CPU_SECOND row under STORAGE — the snapshot job bills GB-days, never seconds', () => {
    expect(costRowsFor(AiUsageUnit.CPU_SECOND).filter((row) => row.capability === AiCapability.STORAGE)).toHaveLength(0);
  });
});

describe('GPU_SECOND — occupancy divided by the provider’s parallel slots', () => {
  const gpuRows = costRowsFor(AiUsageUnit.GPU_SECOND);
  const wildcard = gpuRows.find((row) => row.capability === AiCapability.LLM && (row.provider ?? null) === null);

  it('keeps the provider-wildcard LLM row as the catch-all (TASK-615 B1000000-…-0014)', () => {
    expect(wildcard).toBeDefined();
    expect(wildcard!.unitPriceMicros).toBe(550n);
  });

  // (provider, divisor, capability). The divisor is the engine's concurrency on
  // one card, and every one of these is CITED in the row's own note — a
  // divisor nobody can trace back to a config line is a number, not a rate.
  const DIVISORS: ReadonlyArray<[string, number, AiCapability]> = [
    // LMS_PARALLEL=4 in deployment/k8s/base/lmstudio.yaml. The k3s cluster is
    // the only environment that exists (rule 09 §Cluster Deploys): the EKS
    // component's 8 has no namespace and no Argo Application behind it.
    ['lm-studio', 4, AiCapability.LLM],
    // VLLM_MAX_NUM_SEQS=8 (deployment base/config/vllm.env).
    ['vllm', 8, AiCapability.LLM],
    // Nothing configures OLLAMA_NUM_PARALLEL in either repo, so no parallelism
    // is claimed. Equal to the wildcard by construction — the row records that
    // the divisor was decided, not skipped.
    ['ollama', 1, AiCapability.LLM],
    // The stt BATCH worker's own concurrency: `--processes 2 --threads 4`
    // (apps/stt/docker/Dockerfile). STREAMING admits ~20 sessions per GPU, so
    // these rows overstate streaming COGS by ~2.5× until the book gains an
    // `operation` dimension — stated in each note, not averaged away.
    ['faster_whisper', 8, AiCapability.STT],
    ['whisper_cpp', 8, AiCapability.STT],
    ['parakeet_cpp', 8, AiCapability.STT],
    // One synthesis at a time, and all three default to device `cpu` — so on
    // today's deployment they emit CPU_SECOND and never reach these rows. The
    // rows exist so a CUDA deployment RATES instead of draining unrated, which
    // would read as "TTS cost us nothing" rather than "we never priced it".
    ['kokoro', 1, AiCapability.TTS],
    ['indic_parler', 1, AiCapability.TTS],
    ['indic_f5', 1, AiCapability.TTS],
  ];

  it.each(DIVISORS)('prices %s at the device-hour rate ÷ %i parallel slots, under %s', (provider, slots, capability) => {
    const row = gpuRows.find((candidate) => candidate.provider === provider);
    expect(row, `no GPU_SECOND COST row for ${provider}`).toBeDefined();
    // Occupancy over-counts physical device time by the concurrency factor
    // (§3.1), and the price book is where that is absorbed. Rounded UP, which
    // OVERSTATES cost — the margin-conservative direction for a placeholder.
    const expected = BigInt(Math.ceil(550 / slots));
    expect(row!.unitPriceMicros).toBe(expected);
    expect(row!.capability).toBe(capability);
  });

  it('leaves a provider row STRICTLY cheaper than the wildcard wherever slots > 1, and EQUAL at 1', () => {
    for (const [provider, slots] of DIVISORS) {
      const row = gpuRows.find((candidate) => candidate.provider === provider)!;
      if (slots > 1) expect(row.unitPriceMicros, provider).toBeLessThan(wildcard!.unitPriceMicros);
      else expect(row.unitPriceMicros, provider).toBe(wildcard!.unitPriceMicros);
    }
  });

  it('covers the STT and TTS engines that used to drain unrated — no GPU capability is left without a row', () => {
    for (const capability of [AiCapability.STT, AiCapability.TTS]) {
      expect(gpuRows.filter((row) => row.capability === capability).length, `${capability} has no GPU_SECOND rate`).toBeGreaterThan(0);
    }
  });

  it('names every GPU provider with an id the ledger vocabulary already shapes', () => {
    // A price row keyed on `whispercpp` would never resolve and nothing would
    // say so — it would simply look like the engine was free.
    for (const [provider] of DIVISORS) {
      expect(provider).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    }
  });
});

describe('STORAGE_GB_DAY — priced under the STORAGE capability', () => {
  const rows = costRowsFor(AiUsageUnit.STORAGE_GB_DAY);

  it('has exactly one provider-wildcard row, under capability STORAGE', () => {
    expect(rows).toHaveLength(1);
    expect(rows[0]!.capability).toBe(AiCapability.STORAGE);
    expect(rows[0]!.provider ?? null).toBeNull();
  });

  it('prices a GB-day at the amortised disk rate, NOT zero', () => {
    // The GIGABYTE-day is what makes this representable: `unitPriceMicros` is
    // an integer micro count, so a BYTE-day at the same underlying rate is
    // ~0.0000027µ and could only round to 0 (storage free forever) or 1µ (a
    // GB-month at ~$30,000). ~$0.08/GB-month ÷ 30 = 2666.7µ, rounded UP.
    expect(rows[0]!.unitPriceMicros).toBe(2_667n);
    // Round-trip the rate the SELL side will actually quote.
    const gbMonth = Number(rows[0]!.unitPriceMicros) * 30 / 1_000_000;
    expect(gbMonth).toBeCloseTo(0.08, 3);
  });

  it('carries the arithmetic in its note, so the next reader does not "fix" it', () => {
    expect(rows[0]!.note).toMatch(/GB-month/);
    expect(rows[0]!.note).toMatch(/30/);
  });

  it('is the ONLY storage unit — there is no byte-day row left behind', () => {
    const storageUnits = new Set(costRows.filter((row) => row.capability === AiCapability.STORAGE).map((row) => row.unit));
    expect([...storageUnits]).toEqual([AiUsageUnit.STORAGE_GB_DAY]);
  });
});

describe('EGRESS_BYTE / INGRESS_BYTE — zero is a real rate, recorded per calling capability', () => {
  // §4.1: only these four make outbound third-party calls. NLP and guardrail
  // talk to peer services only, so a byte row under them would describe
  // traffic that does not exist.
  const CALLING = [AiCapability.STT, AiCapability.LLM, AiCapability.TTS, AiCapability.EMBEDDING];

  it.each(CALLING)('prices both directions for %s at 0', (capability) => {
    for (const unit of [AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE]) {
      const rows = costRowsFor(unit).filter((row) => row.capability === capability);
      expect(rows, `${unit} under ${capability}`).toHaveLength(1);
      // ZERO because no vendor and no tunnel bills the platform per byte — a
      // resolved rate of 0 is a decision (D-3: record now, price later), and it
      // is what keeps these rows OUT of the unrated bucket where a genuinely
      // missing price lives.
      expect(rows[0]!.unitPriceMicros).toBe(0n);
    }
  });

  it('declares no byte row for NLP or guardrail traffic — there is none to count', () => {
    for (const unit of [AiUsageUnit.EGRESS_BYTE, AiUsageUnit.INGRESS_BYTE]) {
      expect(costRowsFor(unit).filter((row) => row.capability === AiCapability.NLP)).toHaveLength(0);
    }
  });
});

describe('the SELL gate stays closed until wave 4 (§2.3)', () => {
  it.each(NEW_UNITS)('seeds NO SELL row for %s', (unit) => {
    const offenders = sellRows.filter((row) => row.unit === unit);
    expect(
      offenders.map((row) => row.id),
      `a SELL row for ${unit} without its allowance column and BILLABLE_UNITS entry makes every invoice draft throw`,
    ).toEqual([]);
  });

  it('seeds no SELL row for GPU_SECOND either — it is the cost-truth unit, never sold (D4)', () => {
    expect(sellRows.filter((row) => row.unit === AiUsageUnit.GPU_SECOND)).toEqual([]);
  });

  it('adds no capability to the SELL plane beyond the five inference buckets', () => {
    const sold = new Set(sellRows.map((row) => row.capability).filter((capability): capability is AiCapability => capability != null));
    expect([...sold].sort()).toEqual([AiCapability.EMBEDDING, AiCapability.LLM, AiCapability.NLP, AiCapability.STT, AiCapability.TTS].sort());
  });
});

describe('seed hygiene', () => {
  it('keeps every price-row id unique (the upsert is keyed on it, so a duplicate silently drops a rate)', () => {
    const ids = PRICE_BOOK_SEED_ROWS.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every new-unit COST row a note — a placeholder with no arithmetic is indistinguishable from a real rate', () => {
    for (const unit of [...NEW_UNITS, AiUsageUnit.GPU_SECOND]) {
      for (const row of costRowsFor(unit)) {
        expect(row.note.length, `${row.id} (${unit})`).toBeGreaterThan(20);
      }
    }
  });

  it('declares every USAGE_UNIT row with a capability — a capability-null row can never be resolved', () => {
    for (const row of PRICE_BOOK_SEED_ROWS) {
      if ((row.rowKind ?? AiPriceRowKind.USAGE_UNIT) !== AiPriceRowKind.USAGE_UNIT) continue;
      expect(row.capability, `${row.id} is a USAGE_UNIT row with no capability — dead on arrival`).toBeTruthy();
    }
  });
});
