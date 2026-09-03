import type { CorePrismaClient } from '../../../client';
import { AiCapability, AiPriceBookPlane, AiPriceRowKind, AiUsageUnit, TenantPlan } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_USER_IDS } from './00-constants';

/**
 * AiPriceBook seed — platform rate card, BOTH planes (/ D10).
 *
 * ============================================================================
 * RATIFIED 2026-08-08. These are the commercial rates, not
 * placeholders: COST from researched provider list prices and the self-hosted
 * COGS formula, SELL at the ratified 80% gross margin (5x markup) off a NAMED
 * managed reference per meter.
 *
 * TWO CAVEATS THAT TRAVEL WITH THE NUMBERS:
 *   1. Provider list prices are ~Jan-2026 knowledge, NOT live-fetched. Re-check
 *      the vendor pages before a repricing round.
 *   2. Self-hosted COST assumes ~90% GPU utilization. A clinical duty cycle is
 *      bursty (0.3-0.6), and cost/unit scales INVERSELY with utilization — so
 *      these rows UNDERSTATE self-hosted COGS at a realistic duty cycle, which
 *      is the margin-flattering direction. Each affected row carries the
 *      scaling in its note.
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
 * super admin has since corrected. Superseding is done through the admin API
 * (or the console rate card), not by editing this file and re-running it —
 * editing here only changes what a FRESH database comes up with.
 */

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/**
 * Stamped onto every ledger row this book prices, so an invoice stays
 * reproducible after the card moves on.
 */
const BOOK_VERSION = '2026-08-08-commercial-v1';

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
    unitPriceMicros: 20n,
    note: 'Self-hosted ASR compute — ~$0.072/audio-hour at ~90% GPU utilization (§4). SCALES INVERSELY with utilization: ~30µ at 60%, ~60µ at 30%.',
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
    note: 'Azure Speech real-time/batch list, ~$1.00/audio-hour (§1).',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000004',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: 'openai',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 100n,
    note: 'OpenAI whisper-1 list, $0.006/audio-minute (§1).',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000005',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.STT,
    provider: 'sarvam',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 100n,
    note: 'Sarvam ASR — carried at the Whisper-API reference; not verified against a published card.',
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
    unitPriceMicros: 0n,
    note: 'Self-hosted LLM — ~0.17µ/token at high utilization, BELOW the integer-micro floor, so 0 is the honest rounding (§2). Consequence: self-hosted LLM shows no COGS; SELL is the revenue lever.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000011',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 0n,
    note: 'Self-hosted LLM output — sub-micro per token, see the input row.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000012',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: null,
    unit: AiUsageUnit.REASONING_TOKEN,
    unitPriceMicros: 0n,
    // Reasoning tokens bill as OUTPUT everywhere in the market — seeding them at
    // the output rate keeps the placeholder from understating cost on a
    // thinking-heavy model.
    note: 'Self-hosted reasoning tokens — sub-micro per token, priced as output.',
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

  // --- Managed LLM list prices (~Jan-2026) ---------------------
  // Provider-keyed, so they win over the self-hosted catch-all whenever a call
  // actually runs on that vendor. $/1M tokens equals µ/token numerically.
  {
    id: 'B1000000-0000-0000-0000-000000000023',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'azure',
    model: 'gpt-4.1-mini',
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 1n,
    note: 'Azure OpenAI gpt-4.1-mini input, $0.40/1M (rounded up from 0.4µ to the integer floor).',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000024',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'azure',
    model: 'gpt-4.1-mini',
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 2n,
    note: 'Azure OpenAI gpt-4.1-mini output, $1.60/1M (rounded up).',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000025',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'anthropic',
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 3n,
    note: 'Anthropic Sonnet-class input, $3.00/1M.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000026',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'anthropic',
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 15n,
    note: 'Anthropic Sonnet-class output, $15.00/1M.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000027',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'anthropic',
    unit: AiUsageUnit.CACHE_READ_TOKEN,
    unitPriceMicros: 1n,
    note: 'Anthropic cache read = 0.1x input (0.3µ), rounded up to the integer floor.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000028',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.LLM,
    provider: 'anthropic',
    unit: AiUsageUnit.CACHE_WRITE_TOKEN,
    unitPriceMicros: 4n,
    // The 5m/1h split (1.25x vs 2x input) rides the cacheTtl dimension added by
    // #7; this TTL-agnostic row is the wildcard both resolve through
    // until per-TTL rows are added.
    note: 'Anthropic cache write, 5m TTL = 1.25x input. Per-TTL rows supersede via the cacheTtl dimension.',
  },

  // --- TTS -----------------------------------------------------------------
  {
    id: 'B1000000-0000-0000-0000-000000000030',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.TTS,
    provider: null, // self-hosted kokoro / indic_parler
    unit: AiUsageUnit.CHARACTER,
    unitPriceMicros: 2n,
    note: 'Self-hosted TTS (kokoro / indic_parler) — GPU economics, ~$2.00 per 1M characters (§4).',
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
    unitPriceMicros: 0n,
    note: 'Self-hosted embeddings (lm-studio) — sub-micro per token; see the LLM input row.',
  },
  {
    id: 'B1000000-0000-0000-0000-000000000051',
    plane: AiPriceBookPlane.COST,
    capability: AiCapability.EMBEDDING,
    provider: 'openai',
    model: 'text-embedding-3-small',
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 1n,
    note: 'OpenAI text-embedding-3-small, $0.02/1M (0.02µ rounded up to the integer floor).',
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
    unitPriceMicros: 50_000_000n,
    note: 'RATIFIED 2026-08-08  — $50.00 / month, bundling 50 consultations.',
  },
  {
    id: 'B1000000-0000-0000-0001-000000000003',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.PRO,
    unitPriceMicros: 100_000_000n,
    note: 'RATIFIED 2026-08-08  — $100.00 / month, bundling 250 consultations.',
  },
  {
    id: 'B1000000-0000-0000-0001-000000000004',
    plane: AiPriceBookPlane.SELL,
    rowKind: AiPriceRowKind.PLAN_FEE,
    planTier: TenantPlan.ENTERPRISE,
    unitPriceMicros: 4_999_000_000n,
    // ENTERPRISE is NEGOTIATED per contract. This SYSTEM row is only
    // the fallback list price so the invoice engine (which fails closed on a
    // missing PLAN_FEE row) can still draft; a signed contract MUST be entered
    // as a tenant-scoped SELL row, which is more specific and wins.
    note: 'NOMINAL LIST — $4,999.00 / month. ENTERPRISE is negotiated: supersede with a tenant-scoped row per contract.',
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
    unitPriceMicros: 500n,
    note: 'Streaming STT overage — 5x the ~100µ managed reference (~$0.03/session-minute),  §5.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000002',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.STT,
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 500n,
    note: 'BATCH STT overage at parity with streaming. NOT zero: OQ1 bills batch on AUDIO_SECOND (streaming audio-seconds are excluded upstream), so a 0 here would make batch transcription free.',
  },

  // ── Managed-ASR add-on ─────────────────────────────────────────
  // The rows above are provider-AGNOSTIC and priced off self-hosted economics.
  // These are provider-KEYED and therefore MORE SPECIFIC, so they win whenever
  // overage lands on a platform-funded managed vendor — which, under the
  // SELF_HOSTED-first allowance order, is exactly what spills into overage.
  //
  // 5× the managed COST row (azure-speech AUDIO_SECOND = 278µ) so the add-on
  // carries the ratified 80% margin instead of being subsidised at the
  // self-hosted rate. BYOK never reaches these rows: `prefetchSellRates`
  // resolves the provider-agnostic baseline for BYOK deliberately, because a
  // premium recovering platform COGS makes no sense on a tenant's own key.
  {
    id: 'B1000000-0000-0000-0002-000000000011',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.STT,
    provider: 'azure-speech',
    unit: AiUsageUnit.SESSION_SECOND,
    unitPriceMicros: 1_390n,
    note: 'Managed-ASR add-on — azure-speech streaming, 5× the 278µ managed COST row .',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000012',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.STT,
    provider: 'azure-speech',
    unit: AiUsageUnit.AUDIO_SECOND,
    unitPriceMicros: 1_390n,
    note: 'Managed-ASR add-on — azure-speech batch, parity with the streaming session rate .',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000003',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 5n,
    note: 'LLM input overage — 5x the gpt-4.1-mini-class managed reference, ~$5.00 per 1M input tokens (§5).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000004',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.OUTPUT_TOKEN,
    unitPriceMicros: 10n,
    note: 'LLM output overage — 5x the managed reference, ~$10.00 per 1M output tokens (§5).',
  },
  // The remaining LLM token kinds. The invoice engine FAILS CLOSED on a
  // missing SELL rate (an invoice line cannot be "unrated"), and the pooled
  // `monthlyLlmTokens` allowance covers ALL billable token kinds — so a
  // cache-read or reasoning token falling into overage without a row here
  // would abort the whole draft.
  {
    id: 'B1000000-0000-0000-0002-000000000008',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.CACHE_READ_TOKEN,
    unitPriceMicros: 1n,
    note: 'Cache reads at ~0.2x the input rate (market discount direction).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000009',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.CACHE_WRITE_TOKEN,
    unitPriceMicros: 8n,
    // Per-TTL split (5m ×1.25 vs 1h ×2.00) awaits a price dimension — the
    // ws-b-contract item; a single blended write rate until then.
    note: 'Cache writes at ~1.5x the input rate; the per-TTL split rides the cacheTtl dimension.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000010',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.LLM,
    unit: AiUsageUnit.REASONING_TOKEN,
    unitPriceMicros: 10n,
    note: 'Reasoning tokens priced as OUTPUT (market norm). Required: all billable token kinds pool into monthlyLlmTokens and the engine fails closed on a missing SELL rate.',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000005',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.TTS,
    unit: AiUsageUnit.CHARACTER,
    unitPriceMicros: 80n,
    note: 'TTS overage — 5x the 16µ Azure neural reference, ~$80.00 per 1M characters (§5).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000006',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.NLP,
    unit: AiUsageUnit.TEXT_UNIT,
    unitPriceMicros: 50n,
    note: 'NLP overage per 100-character text unit — self-hosted GLiNER, no managed market; nominal (§5).',
  },
  {
    id: 'B1000000-0000-0000-0002-000000000007',
    plane: AiPriceBookPlane.SELL,
    capability: AiCapability.EMBEDDING,
    unit: AiUsageUnit.INPUT_TOKEN,
    unitPriceMicros: 1n,
    note: 'Embedding overage — 5x the $0.02/1M managed reference lands under the integer floor, so 1µ.',
  },
];

export const PRICE_BOOK_SEED_ROWS: PriceBookSeed[] = [...COST_ROWS, ...PLAN_FEE_ROWS, ...OVERAGE_ROWS];

export const seedAiPriceBook = async (client: CorePrismaClient) => {
  console.log(`Seeding AI price book (${PRICE_BOOK_SEED_ROWS.length} SYSTEM rows, ratified book "${BOOK_VERSION}")...`);

  let created = 0;
  for (const row of PRICE_BOOK_SEED_ROWS) {
    const before = await client.aiPriceBook.findUnique({ where: { id: row.id }, select: { id: true } });

    await client.aiPriceBook.upsert({
      where: { id: row.id },
      // CREATE-ONLY: never clobber a price a super admin has corrected.
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
        // Provenance travels with the row so an admin screen can show WHY a
        // rate is what it is without consulting this file.
        metaData: { ratifiedBy: '', ratifiedOn: '2026-08-08', note: row.note },
        createdBy: CREATED_BY,
      },
    });

    if (!before) created += 1;
  }

  console.log(`  cost/${COST_ROWS.length} · plan-fee/${PLAN_FEE_ROWS.length} · overage/${OVERAGE_ROWS.length}`);
  console.log(`Seeded AI price book: ${created} new row(s), ${PRICE_BOOK_SEED_ROWS.length - created} already present (create-only).`);
  console.log('  Self-hosted COST rows assume ~90% GPU utilization — they understate COGS at a realistic clinical duty cycle (§4).');
};
