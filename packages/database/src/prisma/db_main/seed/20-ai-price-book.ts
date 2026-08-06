import type { CorePrismaClient } from '../../../client';
import { AiCapability, AiPriceBookPlane, AiPriceRowKind, AiUsageUnit, TenantPlan } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_USER_IDS } from './00-constants';

/**
 * AiPriceBook seed — platform rate card, BOTH planes (TASK-615 D4 / D10).
 *
 * ============================================================================
 * EVERY PRICE IN THIS FILE IS A PLACEHOLDER. NONE HAS BEEN COMMERCIALLY
 * APPROVED. Do not bill a customer from these numbers.
 * ============================================================================
 *
 * The seed exists so the plane is EXERCISABLE end to end from a fresh database:
 * the at-ingest rater resolves a COST row and stamps a non-zero `costMicros`,
 * and the invoice engine resolves a PLAN_FEE plus per-capability overage rates
 * and produces a draft invoice. Replacing a number here with a real one is a
 * one-row supersede, not a code change — which is the whole point of an
 * effective-dated, supersede-only table.
 *
 * DELIBERATELY DEFERRED: the full pinned-SHA LiteLLM cost import (hundreds of
 * model-specific rows across every cloud provider). That is a data-sourcing
 * exercise with its own verification burden — an unreviewed bulk import is
 * worse than an obviously-fake placeholder, because a wrong-by-10x real-looking
 * price is invisible while `1` is not. Curated rows only here.
 *
 * SHAPE
 *   - COST plane = COGS, read by the at-ingest rater. Rows with `provider: null`
 *     are the SELF-HOSTED catch-all: resolution is most-specific-wins, so a
 *     provider-specific row beats them whenever one exists. That also makes the
 *     seed robust to whichever provider string the emitters settle on for the
 *     platform's own engines (an open interface question for WS-C/WS-E).
 *   - SELL plane = the tenant-facing card, read only by the invoice engine.
 *     `PLAN_FEE` rows are the recurring fee per tier; the USAGE_UNIT rows are
 *     tier-agnostic overage defaults (`planTier: null`). Per-tier premiums (D12
 *     allows up to ~15%) are added later as MORE SPECIFIC rows that win over
 *     these.
 *
 * UNITS: `unitPriceMicros` is integer micros (1e-6 USD) per ONE unit — per
 * token, per audio second, per character — or per period for a PLAN_FEE row.
 * Integer micros because money must never touch a float.
 *
 * TENANCY: every row is owned by the SYSTEM tenant, which is what makes it the
 * PLATFORM card (`AiPriceBook` is a SYSTEM-shared read model, so every tenant's
 * rater resolves these under its own CLS). A tenant-owned row is the hook for a
 * negotiated enterprise rate and is never seeded.
 *
 * IDEMPOTENT: CREATE-ONLY (`update: {}`), so a re-seed NEVER clobbers a price a
 * global admin has since corrected. Superseding is done through the admin API,
 * not by editing this file and re-running it.
 */

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/**
 * Stamped onto every ledger row this book prices, so an invoice stays
 * reproducible after the card moves on. The `placeholder` marker is deliberate:
 * it shows up in rated rows and in invoice audit reads, making it obvious that
 * nothing here is a real commercial rate.
 */
const BOOK_VERSION = '2026-08-06-placeholder-v1';

/**
 * Far enough in the past that every historical event a fresh dev database can
 * produce falls inside the window. Real rows are dated at the instant the price
 * actually took effect.
 */
const EFFECTIVE_FROM = new Date('2026-01-01T00:00:00.000Z');

interface PriceBookSeed {
  id: string;
  plane: AiPriceBookPlane;
  rowKind?: AiPriceRowKind;
  planTier?: TenantPlan | null;
  capability?: AiCapability | null;
  provider?: string | null;
  model?: string | null;
  unit?: AiUsageUnit | null;
  unitPriceMicros: bigint;
  /** Why this number, in units a human can sanity-check. */
  note: string;
}

// ---------------------------------------------------------------------------
// COST plane — what a call costs the PLATFORM.
// ---------------------------------------------------------------------------

const COST_ROWS: PriceBookSeed[] = [
  // --- STT -----------------------------------------------------------------
  {
    id: 'B1000000-0000-0000-0000-000000000001',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: null, // self-hosted whisper.cpp / faster-whisper pipelines
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 3n,
    note: 'PLACEHOLDER — self-hosted ASR compute, ~$0.011/audio-hour. Ops-owned (OQ4), reviewed quarterly.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000002',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: null,
    unit: AiUsageUnit.SESSION_SECOND,
    unitPriceMicros: 0n,
    // Zero is CORRECT here, not a missing value: an open socket costs the
    // platform nothing beyond the audio it processes, which is already priced
    // above. Session-seconds are the SELL/quota basis (OQ1), not a COGS unit.
    // The row exists so the rater resolves a price rather than failing closed.
    note: 'Session time is not a platform cost — it is the billing basis. Priced on the SELL plane only.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000003',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: 'azure-speech',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 278n,
    note: 'PLACEHOLDER — Azure Speech batch list, ~$1.00/audio-hour.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000004',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: 'openai',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 100n,
    note: 'PLACEHOLDER — OpenAI whisper-1 list, $0.006/audio-minute.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000005',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: 'sarvam',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 100n,
    note: 'PLACEHOLDER — Sarvam ASR, not verified against a published card.',
  },

  // --- LLM -----------------------------------------------------------------
  // Self-hosted catch-alls. Tokens are the SELL unit; GPU-seconds below are the
  // cost-truth unit recorded alongside them (D4).
  {
    id: 'B1000000-0000-0000-0000-000000000010',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 1n,
    note: 'PLACEHOLDER — self-hosted (ollama/lm-studio/vllm/llama-cpp), $1.00 per 1M input tokens.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000011',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 3n,
    note: 'PLACEHOLDER — self-hosted, $3.00 per 1M output tokens.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000012',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.REASONING_TOKEN,
    unitPriceMicros: 3n,
    // Reasoning tokens bill as OUTPUT everywhere in the market — seeding them at
    // the output rate keeps the placeholder from understating cost on a
    // thinking-heavy model.
    note: 'PLACEHOLDER — self-hosted; reasoning tokens are priced as output (market norm).',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000013',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.CACHE_READ_TOKEN,
    unitPriceMicros: 1n,
    // A self-hosted engine has no cache-discount economics; the row exists so
    // cache-read rows rate instead of failing closed.
    note: 'PLACEHOLDER — self-hosted; no cache discount applies, priced as input.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000014',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.GPU_SECOND,
    unitPriceMicros: 550n,
    note: 'PLACEHOLDER — ~$1.98/GPU-hour amortised. The COST-TRUTH unit for self-hosted inference.',
  },
  // One representative cloud provider so the deployment=CLOUD path is
  // exercisable. The remaining providers resolve to the self-hosted catch-alls
  // until the LiteLLM import lands, which OVERSTATES margin rather than
  // understating it — the safe direction for a placeholder.
  {
    id: 'B1000000-0000-0000-0000-000000000020',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'openai',
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 3n,
    note: 'PLACEHOLDER — mid-tier cloud list, $3.00 per 1M input tokens. NOT model-specific.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000021',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'openai',
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 15n,
    note: 'PLACEHOLDER — mid-tier cloud list, $15.00 per 1M output tokens. NOT model-specific.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000022',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'openai',
    unit: AiUsageUnit.CACHE_READ_TOKEN,
    unitPriceMicros: 1n,
    // ~90% off input is the converged cross-vendor cache-read discount.
    note: 'PLACEHOLDER — cache read at ~10% of input (converged market discount).',
  },

  // --- TTS -----------------------------------------------------------------
  {
    id: 'B1000000-0000-0000-0000-000000000030',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.TTS,
    provider: null, // self-hosted kokoro / indic_parler
    unit: AiUsageUnit.CHARACTER,
    unitPriceMicros: 1n,
    note: 'PLACEHOLDER — self-hosted TTS compute, $1.00 per 1M characters.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000031',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.TTS,
    provider: 'azure',
    unit: AiUsageUnit.CHARACTER,
    unitPriceMicros: 16n,
    note: 'PLACEHOLDER — Azure neural TTS list, ~$16.00 per 1M characters.',
  },
  {
    // WS-K evidence run found TTS AUDIO_SECOND events drain UNRATED without this
    // wildcard — TTS emits CHARACTER (sell unit) + AUDIO_SECOND (cost unit) per
    // request, and the cost plane must resolve both.
    id: 'B1000000-0000-0000-0000-000000000032',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.TTS,
    provider: null, // wildcard — synthesized-output seconds, any engine
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 0n,
    note: 'PLACEHOLDER (deliberate 0) — TTS output-duration COGS is carried by the CHARACTER row for now; this row exists so AUDIO_SECOND events rate instead of draining unrated.',
  },

  // --- NLP -----------------------------------------------------------------
  {
    id: 'B1000000-0000-0000-0000-000000000040',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.NLP,
    provider: null,
    unit: AiUsageUnit.TEXT_UNIT,
    unitPriceMicros: 10n,
    note: 'PLACEHOLDER — self-hosted medical NER, $0.00001 per 100-character text unit.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000041',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.NLP,
    provider: null,
    unit: AiUsageUnit.REQUEST,
    unitPriceMicros: 0n,
    // Requests are counted for shape/abuse analysis, not charged — text units
    // carry the cost. Zero here is a decision, not a gap.
    note: 'Request count is a shape metric, not a charge — text units carry NLP cost.',
  },

  // --- EMBEDDING -----------------------------------------------------------
  {
    id: 'B1000000-0000-0000-0000-000000000050',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.EMBEDDING,
    provider: null,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 1n,
    note: 'PLACEHOLDER — self-hosted embeddings (diarization/RAG), $1.00 per 1M tokens.',
  },
];

// ---------------------------------------------------------------------------
// SELL plane — what a TENANT pays.
// ---------------------------------------------------------------------------

/**
 * Recurring plan fees, per period, in micros. TRIAL is free by design (it is a
 * one-week PRO-entitled window), so its zero is a product decision rather than
 * an unset placeholder.
 */
const PLAN_FEE_ROWS: PriceBookSeed[] = [
  {
    id: 'B1000000-0000-0000-0001-000000000001',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.TRIAL,
    unitPriceMicros: 0n,
    note: 'TRIAL is a free 1-week PRO-entitled window — zero is intentional, not a placeholder.',
  },
  {
    id: 'B1000000-0000-0000-0001-000000000002',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.STARTER,
    unitPriceMicros: 199_000_000n,
    note: 'PLACEHOLDER — $199.00 / month.',
  },
  {
    id: 'B1000000-0000-0000-0001-000000000003',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.PRO,
    unitPriceMicros: 999_000_000n,
    note: 'PLACEHOLDER — $999.00 / month.',
  },
  {
    id: 'B1000000-0000-0000-0001-000000000004',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.ENTERPRISE,
    unitPriceMicros: 4_999_000_000n,
    note: 'PLACEHOLDER — $4,999.00 / month.',
  },
];

/**
 * Tier-agnostic overage defaults (`planTier: null`), charged only on usage ABOVE
 * a plan's included allowance.
 *
 * Priced at a modest premium over the corresponding self-hosted COST row —
 * never punitive (D12). Per-tier rows added later are MORE SPECIFIC and win
 * over these without anything here changing.
 *
 * No GUARDRAIL row exists, and that is deliberate: guardrail LLM usage is
 * metered for COGS but NEVER line-itemed to a tenant (D16). A SELL price for it
 * would be a bug waiting to be resolved by the invoice engine.
 */
const OVERAGE_ROWS: PriceBookSeed[] = [
  {
    id: 'B1000000-0000-0000-0002-000000000001',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.STT,
    unit: AiUsageUnit.SESSION_SECOND,
    unitPriceMicros: 6n,
    note: 'PLACEHOLDER — ~$0.0216 per streaming session-minute above allowance (OQ1 basis).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000002',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.STT,
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 6n,
    note: 'PLACEHOLDER — batch STT overage, parity with the streaming session rate.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000003',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 2n,
    note: 'PLACEHOLDER — $2.00 per 1M input tokens above allowance.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000004',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 6n,
    note: 'PLACEHOLDER — $6.00 per 1M output tokens above allowance.',
  },
  // The remaining LLM token kinds. The invoice engine FAILS CLOSED on a
  // missing SELL rate (an invoice line cannot be "unrated"), and the pooled
  // `monthlyLlmTokens` allowance covers ALL billable token kinds — so a
  // cache-read or reasoning token falling into overage without a row here
  // would abort the whole draft (TASK-615 WS-I).
  {
    id: 'B1000000-0000-0000-0002-000000000008',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.CACHE_READ_TOKEN,
    unitPriceMicros: 1n,
    note: 'PLACEHOLDER — cache reads at half the input overage rate (market discount direction).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000009',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.CACHE_WRITE_TOKEN,
    unitPriceMicros: 3n,
    // Per-TTL split (5m ×1.25 vs 1h ×2.00) awaits a price dimension — the
    // ws-b-contract §11 item; a single blended write rate until then.
    note: 'PLACEHOLDER — cache writes at ~1.5× input overage; per-TTL split deferred (needs a cacheTtl price dimension).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000010',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.REASONING_TOKEN,
    unitPriceMicros: 6n,
    note: 'PLACEHOLDER — reasoning tokens priced as output (market norm).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000005',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.TTS,
    unit: AiUsageUnit.CHARACTER,
    unitPriceMicros: 2n,
    note: 'PLACEHOLDER — $2.00 per 1M characters above allowance.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000006',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.NLP,
    unit: AiUsageUnit.TEXT_UNIT,
    unitPriceMicros: 15n,
    note: 'PLACEHOLDER — per 100-character text unit above allowance.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000007',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.EMBEDDING,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 2n,
    note: 'PLACEHOLDER — $2.00 per 1M embedding tokens above allowance.',
  },
];

export const PRICE_BOOK_SEED_ROWS: PriceBookSeed[] = [...COST_ROWS, ...PLAN_FEE_ROWS, ...OVERAGE_ROWS];

export const seedAiPriceBook = async (client: CorePrismaClient) => {
  console.log(`Seeding AI price book (${PRICE_BOOK_SEED_ROWS.length} SYSTEM rows — ALL PLACEHOLDER prices, book "${BOOK_VERSION}")...`);

  let created = 0;
  for (const row of PRICE_BOOK_SEED_ROWS) {
    const before = await client.aiPriceBook.findUnique({ where: { id: row.id }, select: { id: true } });

    await client.aiPriceBook.upsert({
      where: { id: row.id },
      // CREATE-ONLY: never clobber a price a global admin has corrected.
      update: {},
      create: {
        id: row.id,
        tenantId: SYSTEM_TENANT_ID,
        plane: row.plane,
        rowKind: row.rowKind ?? AiPriceRowKind.USAGE_UNIT,
        planTier: row.planTier ?? null,
        capability: row.capability ?? null,
        provider: row.provider ?? null,
        model: row.model ?? null,
        unit: row.unit ?? null,
        contextBand: null,
        currency: 'USD',
        unitPriceMicros: row.unitPriceMicros,
        effectiveFrom: EFFECTIVE_FROM,
        effectiveTo: null,
        bookVersion: BOOK_VERSION,
        // The marker travels with the row so an admin screen can flag an
        // un-reviewed rate without consulting this file.
        metaData: { placeholder: true, note: row.note },
        createdBy: CREATED_BY,
      },
    });

    if (!before) created += 1;
  }

  console.log(`  cost/${COST_ROWS.length} · plan-fee/${PLAN_FEE_ROWS.length} · overage/${OVERAGE_ROWS.length}`);
  console.log(`Seeded AI price book: ${created} new row(s), ${PRICE_BOOK_SEED_ROWS.length - created} already present (create-only).`);
  console.log('  ⚠️  All seeded prices are PLACEHOLDERS — replace via the admin rate-card API (supersede) before billing anyone.');
};
