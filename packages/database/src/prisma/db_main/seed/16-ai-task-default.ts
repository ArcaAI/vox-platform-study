import type { AiTaskKind } from '../../../generated/core-prisma-client/enums';
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * AiTaskDefault Seed (centralized task-model configuration)
 *
 * Seeds the SYSTEM-tenant (`00000000-…`) platform defaults for the
 * non-pipeline AI tasks — the Class-3 generalization of
 * `HarnessPolicy.textProvider/textModel`:
 *
 *   - guardrail.validate → granite-guardian-4.1-8b (GUARDRAIL row)
 *   - nlp.ner → medical-ner (TOKEN_CLASSIFICATION row)
 * - nlp.classification → nlp-doc-type-classifier (TEXT_CLASSIFICATION, DISABLED placeholder —)
 * - nlp.diagnosis → symps-disease-bert-v3-c41 (TEXT_CLASSIFICATION row —)
 * - guardrail.safety → gliguard-llm-guardrails-300m (LLM safety moderation, six tasks)
 * - guardrail.pii → gliner2-privacy-filter-pii-multi (PII spans; English only)
 * guardrail.pii.spans → gliner2-guardrails-pii-multi (joint PII spans + safety;)
 * - guardrail.groundedness → minicheck-flan-t5-large (TEXT_CLASSIFICATION row —)
 * - text.live / text.finalize / text.test / harness.judge → lms-gemma-4-e4b-it-qat
 * (TEXT_GENERATION rows; owner directive 2026-09-03)
 *
 * Resolution at runtime (AiTaskDefaultService.getEffective): tenant row →
 * SYSTEM row → consuming service's env fallback.
 *
 * Governance: the `guardrail.`, `nlp.`, and `harness.` task-key prefixes are
 * SUPER_ADMIN-ONLY (service-level isSuperAdmin guard on writes) per
 * SUPER_ADMIN_ONLY_TASK_PREFIXES in
 * packages/applications/src/services/ai-task-default/constants.ts. For those,
 * tenants only CONSUME the SYSTEM-row platform default and runtime resolution
 * ignores per-tenant override rows. EXCEPTION: the `text.` prefix is
 * tenant-admin configurable — the SYSTEM rows below are still seeded as the
 * platform default, but tenants may override them with their own rows. The
 * per-tenant `text.live.fallback` / `text.finalize.fallback` keys are opt-in and
 * deliberately have NO SYSTEM seed row (unset ⇒ no fallback runs).
 *
 * CREATE-ONLY: an existing (tenantId, taskKey) row is NEVER overwritten — the
 * platform default is admin-tunable at runtime and a re-seed must not clobber
 * an admin's choice. Depends on the AiModel catalog (seedStt) for the slugs.
 */

/**
 * `taskKey` → `AiTaskKind`, for the keys THIS SEED writes.
 *
 * A deliberate mirror of `AI_TASK_KIND_BY_TASK_KEY`
 * (`packages/applications/src/services/ai-task-default/constants.ts`), because
 * `packages/database` cannot import from `packages/applications` without
 * inverting the dependency direction. It is kept honest by the same
 * `ai-task-kind.test.ts` drift guard that pins the migration SQL: all three
 * copies of this mapping are compared against the one declaration.
 */
const AI_TASK_KIND_BY_SEEDED_TASK_KEY: Record<string, AiTaskKind> = {
  'text.live': 'TEXT_GENERATION',
  'text.finalize': 'TEXT_GENERATION',
  'text.live.fallback': 'TEXT_GENERATION',
  'text.finalize.fallback': 'TEXT_GENERATION',
  'text.test': 'TEXT_GENERATION',
  'harness.judge': 'TEXT_GENERATION',
  'vlm.extract': 'VISION_EXTRACTION',
  'nlp.ner': 'NAMED_ENTITY_RECOGNITION',
  'nlp.classification': 'TEXT_CLASSIFICATION',
  'nlp.diagnosis': 'TEXT_CLASSIFICATION',
  'nlp.sentiment': 'TEXT_CLASSIFICATION',
  'nlp.toxicity': 'TEXT_CLASSIFICATION',
  'nlp.topic': 'TEXT_CLASSIFICATION',
  'nlp.intent': 'TEXT_CLASSIFICATION',
  'guardrail.validate': 'CONTENT_SAFETY',
  'guardrail.safety': 'CONTENT_SAFETY',
  'guardrail.groundedness': 'GROUNDEDNESS',
  'guardrail.pii': 'PII_DETECTION',
  'guardrail.pii.spans': 'PII_DETECTION',
};

export interface AiTaskDefaultSeed {
  id: string;
  tenantId: string;
  taskKey: string;
  modelSlug: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CUSTOMER TENANTS GET NO ROWS HERE — do not "complete" this.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every row above targets SYSTEM. Neither seeded CUSTOMER tenant — Global
 * (`50000000-…0000`) nor ArcaAI (`50000000-…0001`) — has an `AiTaskDefault`,
 * `AiProviderConnection`, `AiRuntimeProfile` or `TenantStorageConfig` row, and
 * that is CORRECT. It reads like a half-finished seed; it is not.
 *
 * Resolution is `request tenant → SYSTEM`, and ABSENCE is the load-bearing
 * state: no row means "this tenant has no opinion", which is precisely what
 * makes the tenant inherit the platform default — including every future
 * change to it. Writing a customer-tenant row here would not "provision" that
 * tenant, it would PIN it: the tenant would win its own cascade forever and
 * silently stop tracking the platform default the moment a super admin moved
 * it. Seeding a copy of today's SYSTEM value is therefore the one action
 * guaranteed to break inheritance while looking like configuration.
 *
 * Global additionally must never appear in a runtime cascade at all — it is a
 * platform-admin PLAYGROUND for trialling config before promoting it into
 * SYSTEM, not a config tier (`.claude/rules/00-project-context.md`,
 * "The two reserved tenants are NOT two config tiers").
 *
 * What a customer tenant DOES need to be usable is operational scaffolding, and
 * it has it: users, role assignments, departments, storage buckets, a plan, and
 * prompt templates/agents are all seeded for both. Per-tenant AI configuration
 * is written at runtime by a tenant admin exercising BYO — never by this seed.
 *
 * Enforced by `__tests__/task-799-ai-task-default-completeness.test.ts`
 * ("every seed row targets the SYSTEM tenant").
 */

/**
 * Declared task keys that deliberately carry NO SYSTEM seed row, and why.
 *
 * The completeness guard (`__tests__/task-799-ai-task-default-completeness.test.ts`)
 * fails on any `AI_TASK_KEYS` entry that is neither seeded above nor listed
 * here. An absence must be a DECISION with a reason attached, never an
 * oversight — every `models.<taskKey>` descriptor is `failMode: 'closed'`, so
 * an unseeded key 503s forever on a platform that looks fully configured.
 *
 * Keys mapped to the empty string are refused by the guard: write the reason.
 */
export const SYSTEM_TASK_DEFAULT_EXEMPTIONS: Record<string, string> = {
  // ── opt-in by construction: a SYSTEM row would CHANGE behaviour ──────────
  'text.live.fallback':
    'Opt-in per-tenant fallback. `resolveTextFallbackSelection` fails OPEN: no row means no fallback runs. ' +
    'A SYSTEM row would not be a default — it would switch a second provider on for every tenant that never asked for one, ' +
    'and bill them for it. Absence IS the correct platform posture, not a gap.',
  'text.finalize.fallback':
    'Opt-in per-tenant fallback, identical reasoning to `text.live.fallback`: fail-open, so a SYSTEM row would enable a ' +
    'second provider platform-wide rather than express a default. Absence IS the correct platform posture.',

  // ── no deployable model exists to point at ──────────────────────────────
  'vlm.extract':
    'DELIBERATE, and already documented at the model row: `lms-medgemma-1.5-4b-it-vision` (seed/ai-models/llm.ts) is ' +
    'catalogued but its weights are not loaded on the LM Studio instance, so a SYSTEM default would replace a clean ' +
    '"not configured" 503 with an upstream 404 from an engine that cannot serve it. Unlike the `nlp.*` keys this one is ' +
    'tenant-admin configurable (NOT in SUPER_ADMIN_ONLY_TASK_PREFIXES), so a tenant with a BYOK vision credential can ' +
    'configure it today — the absence blocks nobody permanently.',

  // ── declared, but nothing can call them yet ─────────────────────────────
  // Both keys were added by together with the `apps/nlp` endpoints
  // that would serve them, but the GATEWAY half was never built: the only
  // caller, `AiInferenceController`, types its resolver as
  // `taskKey: 'nlp.ner' | 'nlp.diagnosis'` (ai-inference.controller.ts:379),
  // so no request can reach either key. Seeding a model here would configure a
  // capability nothing can invoke, and would have to name a checkpoint nobody
  // has chosen — proved the plumbing against the FIXTURE ids
  // `org/sentiment-model` / `org/toxicity-model`
  // (apps/nlp/tests/test_classify_sentiment_toxicity.py:90,120), never a real
  // one. On a clinical platform a plausible-but-unvetted classifier is worse
  // than a 503: it returns confident numbers nobody validated. That is the same
  // judgement that repointed `nlp.classification` away from the wrong-but-real
  // `symps-disease-bert-v3-c41` and onto a DISABLED placeholder.
  'nlp.sentiment':
    'No checkpoint has been selected, and no gateway route can reach the key. Choosing a sentiment model is an OPEN OWNER ' +
    'DECISION: the catalog holds no sentiment classifier, so `upsertRow` would reject every slug a super admin could name. ' +
    'Seed an ENABLED SYSTEM AiModel (TEXT_CLASSIFICATION) first; the row here follows from that choice, not before it.',
  'nlp.toxicity':
    'No checkpoint has been selected, and no gateway route can reach the key. Same OPEN OWNER DECISION as `nlp.sentiment`, ' +
    'with one extra constraint: toxicity is MULTI-LABEL (owner decision 2026-08-20), so the chosen checkpoint must expose an ' +
    'independent per-label head and carry a `_metadata.labelTaxonomy.cls_threshold`, not a softmax over one winner.',
};

/**
 * Seeded task keys that `AI_TASK_KEYS` does NOT declare — the mirror gap.
 *
 * These two rows ARE load-bearing: `apps/guardrail` reads `AiTaskDefault` by
 * `task_key` over its own read-only SQL connection (the sanctioned peer-service
 * exception — `apps/guardrail/src/guardrail/core/tenant_config.py:128` pins
 * `TASK_KEY_GUARDRAIL_PII`), so the PII selection resolves at runtime without
 * ever passing through `AiTaskDefaultService`.
 *
 * The consequence is a governance hole, not a runtime one: because the keys are
 * absent from `AI_TASK_KEYS`, `assertKnownTaskKey` rejects them on every admin
 * route, and no `models.guardrail.pii*` descriptor exists — so the platform's
 * PII-model selection cannot be read or changed by any administrator, through
 * any surface. Closing it means registering both keys AND adding their `META`
 * entries in `settings-registry/descriptors/model-defaults.descriptors.ts`
 * (whose `Record<AiTaskKey, …>` makes the two edits inseparable), which widens
 * the settings catalog and is an owner-facing decision — `guardrail.*` is
 * tenant-configurable, so registering these keys would also decide whether a
 * tenant may pick its own PII model.
 *
 * The guard pins this set EXACTLY, so a third such row cannot appear silently
 * while the decision is open.
 */
// CLOSED. Both keys are now declared in `AI_TASK_KEYS` and are
// SUPER_ADMIN-only via `SUPER_ADMIN_ONLY_TASK_KEYS` (owner decision 2026-08-24:
// they select nlp-hosted TOKEN_CLASSIFICATION models, and D-4 makes those
// platform-shared; PII redaction is a PHI control, so one vetted model serves
// every tenant). The list stays as the declared-exemption mechanism — it is
// EMPTY, and the completeness test fails if a future seed adds a key here
// without registering it.
export const SEEDED_TASK_KEYS_NOT_IN_REGISTRY: readonly string[] = [];

/** Deterministic ids — fresh `86000000-…` block (unused by any other seed). */
export const SYSTEM_AI_TASK_DEFAULTS: AiTaskDefaultSeed[] = [
  {
    id: '86000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.validate',
    modelSlug: 'granite-guardian-4.1-8b',
  },
  {
    id: '86000000-0000-0000-0000-000000000002',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'nlp.ner',
    modelSlug: 'medical-ner',
  },
  {
    // repointed at an explicitly DISABLED doc-type placeholder.
    // `nlp.classification` is the `/classify/text` document-type classifier;
    // it no longer points at the diagnosis suggester (moved to nlp.diagnosis).
    // No doc-type model is deployed, so the capability fails closed until a
    // real classifier is seeded. CREATE-ONLY: existing rows keep the admin's
    // choice; only a cold seed picks up the corrected slug.
    id: '86000000-0000-0000-0000-000000000003',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'nlp.classification',
    modelSlug: 'nlp-doc-type-classifier',
  },
  // the diagnosis suggester is now keyed under `nlp.diagnosis`
  // (the /diagnosis endpoint), separate from the doc-type classifier.
  {
    id: '86000000-0000-0000-0000-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'nlp.diagnosis',
    modelSlug: 'symps-disease-bert-v3-c41',
  },
  // TEXT generation routing. Both live and finalize point at the same platform
  // default; a super admin OR a tenant admin may split or override them later.
  // `resolveTextSelection` consults these keys FIRST. NOTE: the per-tenant
  // `text.<task>.fallback` keys are opt-in and intentionally NOT seeded here.
  //
  // OWNER DIRECTIVE 2026-09-03: every text-generation task routes
  // to LM Studio `gemma-4-e4b-it-qat` — registry slug `lms-gemma-4-e4b-it-qat`,
  // the QAT build of `google/gemma-4-E4B-it-qat-q4_0-gguf`. These rows used to
  // name the E2B sibling, which was chosen when the platform default mirrored
  // `HarnessPolicy` SYSTEM `textProvider/textModel` (lm-studio /
  // gemma-4-e2b-it-qat); the directive supersedes that mirroring for the
  // `text.*` plane. `HarnessPolicy`'s own SYSTEM row is a DIFFERENT tier and is
  // left alone here — `resolveTextSelection` reads AiTaskDefault first, so
  // these rows are what actually decide the model.
  //
  // ⚠ `seedAiTaskDefault` is CREATE-ONLY, so this only decides a COLD seed. An
  // already-seeded database keeps its E2B rows until the data
  // migration (`…_task_858_text_defaults_gemma_e4b`) repoints exactly the rows
  // that still carry the OLD seeded values.
  {
    id: '86000000-0000-0000-0000-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'text.live',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
  },
  {
    id: '86000000-0000-0000-0000-000000000005',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'text.finalize',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
  },
  // BUG-018 — the prompt-template Test button's own routing key. It exists so
  // the Test path resolves through AiTaskDefault ALONE: before this row the
  // key was consulted, missed, and the caller fell through to the HARNESS
  // `text.finalize` cascade to find any model at all — which is how a tenant
  // that had selected Azure OpenAI still ran every template test on the
  // platform's LM Studio gemma. Testing a prompt is prompt-authoring, not
  // clinical documentation; it must not read harness policy to pick a model.
  // Seeded at the same platform default so a template test resolves the same
  // model the live/finalize paths do; a tenant admin may repoint `text.test`
  // freely. Moved to `lms-gemma-4-e4b-it-qat` with its siblings above (owner
  // directive 2026-09-03) — testing a prompt against a model no clinical path
  // uses would make the Test button answer a question nobody asked.
  {
    id: '86000000-0000-0000-0000-000000000010',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'text.test',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
  },
  // Guardrail selection moved out of env into the DB control plane
  // . Both keys are SUPER_ADMIN-only.
  // the safety plane is TWO selections now, because the
  // owner-specified models are two different models: moderation and PII are
  // different jobs. Both RUN IN `apps/nlp`; `apps/guardrail` holds no weights.
  // Their label taxonomies ride on the `AiModel._metadata.labelTaxonomy` of the
  // rows below, resolved through the same tenant → SYSTEM cascade.
  {
    id: '86000000-0000-0000-0000-000000000006',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.safety',
    modelSlug: 'gliguard-llm-guardrails-300m',
  },
  {
    id: '86000000-0000-0000-0000-000000000011',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.pii',
    modelSlug: 'gliner2-privacy-filter-pii-multi',
  },
  // the third selection. `guardrail.pii` is the high-volume redaction
  // path (dedicated 205M span model); `guardrail.pii.spans` is the JOINT
  // checkpoint, for prompt/response safety that needs SPANS rather than a bare
  // label. Two keys, not one, because they are different jobs with different
  // latency budgets — collapsing them would make every redaction pay for a
  // classification head it does not use.
  {
    id: '86000000-0000-0000-0000-000000000012',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.pii.spans',
    modelSlug: 'gliner2-guardrails-pii-multi',
  },
  {
    id: '86000000-0000-0000-0000-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.groundedness',
    modelSlug: 'minicheck-flan-t5-large',
  },
  // Harness LLM-as-judge selection moved out of env into the DB
  // control plane. SUPER_ADMIN-only; SYSTEM wins.
  {
    id: '86000000-0000-0000-0000-000000000008',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'harness.judge',
    // OWNER DIRECTIVE 2026-08-16: "do not use llama.cpp for judgement, we use
    // LM Studio and google/gemma-4-e4b". This row IS the runtime judgement path
    // (the inferential sensor resolves the `harness.judge` AiTaskDefault, not
    // `JudgeConfig.model`'s code default), so it carries the directive.
    //
    // An earlier pass repointed this to `lms-gemma-4-e2b-it-qat` because
    // `lms-gemma-4-e4b`'s sourceUri then read `google/gemma-4-e4b-qat` — an id
    // LM Studio has never served, so every judge call 404d. That sourceUri has
    // since been corrected to `google/gemma-4-e4b`, which the live instance DOES
    // serve (verified 2026-08-16, ai-models/llm.ts).
    //
    // OWNER DIRECTIVE 2026-09-03 moves it once more, to
    // `lms-gemma-4-e4b-it-qat`. That is a NARROWING of the 2026-08-16 directive,
    // not a reversal of it: both rows are E4B, and the QAT row names the wire id
    // the deployed LM Studio actually serves (`gemma-4-e4b-it-qat` =
    // `google/gemma-4-E4B-it-qat-q4_0-gguf`), while `lms-gemma-4-e4b` points at
    // the un-quantized `google/gemma-4-e4b`. The 2026-09-03 directive names the
    // QAT build explicitly for ALL text generation, and judgement is text
    // generation, so the judge follows the same row rather than keeping a
    // second E4B identity alive beside it.
    //
    // Latency note: e4b is the larger model (~90s/call observed vs e2b's
    // faster turn). That is the owner's accepted trade for judgement quality;
    // it is why the eval gate's CI-provisioning path is still an open choice.
    // `seedAiTaskDefault` is CREATE-ONLY, so this only decides a COLD seed —
    // existing databases move via the data migration.
    modelSlug: 'lms-gemma-4-e2b-it-qat',
  },
];

export const seedAiTaskDefault = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiTaskDefault rows ...');

  let created = 0;
  let skipped = 0;
  for (const row of SYSTEM_AI_TASK_DEFAULTS) {
    const existing = await client.aiTaskDefault.findFirst({
      where: { tenantId: row.tenantId, taskKey: row.taskKey },
    });

    if (existing) {
      // CREATE-ONLY — never overwrite an admin-managed default.
      console.log(`  AiTaskDefault "${row.taskKey}" exists (→ ${existing.modelSlug}) — KEPT AS IS, not updated to "${row.modelSlug}"`);
      skipped += 1;
      continue;
    }

    console.log(`  Creating AiTaskDefault "${row.taskKey}" → ${row.modelSlug}`);
    await client.aiTaskDefault.create({
      data: {
        id: row.id,
        tenantId: row.tenantId,
        taskKey: row.taskKey,
        modelSlug: row.modelSlug,
        // added the column and backfilled the dev DB through
        // a side-car script, but never taught this writer to set it, so every
        // freshly seeded environment landed 12 UNCLASSIFIED rows. Derived, never
        // chosen: the mapping is `AI_TASK_KIND_BY_TASK_KEY` in the applications
        // layer, mirrored here because the seed cannot import from it.
        // `?? null` is fail-closed — an unrecognised key stays unclassified
        // rather than being guessed into a plausible-but-wrong kind.
        taskKind: AI_TASK_KIND_BY_SEEDED_TASK_KEY[row.taskKey] ?? null,
        createdBy: SYSTEM_USER_ID,
      },
    });
    created += 1;
  }

  console.log(`Seeded AiTaskDefault: ${created} created, ${skipped} skipped`);
  if (skipped > 0) {
    console.warn(
      `⚠️  ${skipped} AiTaskDefault row(s) already existed and were NOT UPDATED. This phase is create-only by ` +
        'design — a re-seed must never clobber a model selection an admin made at runtime. If you expected the seed to ' +
        'change one of these, it did not: repoint it through PUT /api/v1/admin/ai-task-defaults/:taskKey, or delete the ' +
        'row first and re-seed.',
    );
  }
  return { success: true, created, skipped };
};
