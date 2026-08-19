import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * AiTaskDefault Seed (centralized task-model configuration)
 *
 * Seeds the SYSTEM-tenant (`00000000-…`) platform defaults for the
 * non-pipeline AI tasks — the Class-3 generalization of
 * `HarnessPolicy.textProvider/textModel`:
 *
 *   - guardrail.validate   → granite-guardian-4.1-8b     (GUARDRAIL row)
 *   - nlp.ner              → medical-ner                 (TOKEN_CLASSIFICATION row)
 * - nlp.classification → nlp-doc-type-classifier (TEXT_CLASSIFICATION, DISABLED placeholder — )
 * - nlp.diagnosis → symps-disease-bert-v3-c41 (TEXT_CLASSIFICATION row — )
 * - guardrail.safety → gliguard-llm-guardrails-300m (LLM safety moderation, six tasks)
 * - guardrail.pii → gliner2-privacy-filter-pii-multi (PII spans; English only)
 * - guardrail.groundedness → minicheck-flan-t5-large (TEXT_CLASSIFICATION row — )
 * - harness.judge → lms-gemma-4-e4b (TEXT_GENERATION row; owner directive 2026-08-16)
 *
 * Resolution at runtime (AiTaskDefaultService.getEffective): tenant row →
 * SYSTEM row → consuming service's env fallback.
 *
 * Governance: the `guardrail.`, `nlp.`, and `harness.` task-key prefixes are
 * SUPER_ADMIN-ONLY (service-level isSuperAdmin guard on writes) per
 * SUPER_ADMIN_ONLY_TASK_PREFIXES in
 * packages/applications/src/services/ai-task-default/constants.ts. For those,
 * tenants only CONSUME the SYSTEM-row platform default and runtime resolution
 * ignores per-tenant override rows. EXCEPTION: the `smr.` prefix is
 * tenant-admin configurable — the SYSTEM rows below are still seeded as the
 * platform default, but tenants may override them with their own rows. The
 * per-tenant `text.live.fallback` / `text.finalize.fallback` keys are opt-in and
 * deliberately have NO SYSTEM seed row (unset ⇒ no fallback runs).
 *
 * CREATE-ONLY: an existing (tenantId, taskKey) row is NEVER overwritten — the
 * platform default is admin-tunable at runtime and a re-seed must not clobber
 * an admin's choice. Depends on the AiModel catalog (seedStt) for the slugs.
 */

export interface AiTaskDefaultSeed {
  id: string;
  tenantId: string;
  taskKey: string;
  modelSlug: string;
}

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
  // SMR generation routing, mapped to the CURRENT SMR
  // default (HarnessPolicy SYSTEM textProvider/textModel = lm-studio /
  // gemma-4-e2b-it-qat, registry slug `lms-gemma-4-e2b-it-qat`). Both live and
  // finalize point at the same platform default today; a super admin OR a
  // tenant admin may split or override them later.
  // `resolveTextSelection` consults these keys FIRST. NOTE: the per-tenant
  // `smr.<task>.fallback` keys are opt-in and intentionally NOT seeded here.
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
  // Seeded at the same platform default so behaviour is unchanged for tenants
  // that never override it; a tenant admin may repoint `text.test` freely.
  {
    id: '86000000-0000-0000-0000-000000000010',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'text.test',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
  },
  // Guardrail selection moved out of env into the DB control plane
  // (Phase B). Both keys are SUPER_ADMIN-only.
  // TASK-735 Phase 3 — the safety plane is TWO selections now, because the
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
  {
    id: '86000000-0000-0000-0000-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    taskKey: 'guardrail.groundedness',
    modelSlug: 'minicheck-flan-t5-large',
  },
  // Harness LLM-as-judge selection moved out of env into the DB
  // control plane (Phase C). SUPER_ADMIN-only; SYSTEM wins.
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
    // serve (verified 2026-08-16, ai-models/llm.ts), so the reason for the
    // repoint no longer holds and it is reverted here.
    //
    // Latency note: e4b is the larger model (~90s/call observed vs e2b's
    // faster turn). That is the owner's accepted trade for judgement quality;
    // it is why the eval gate's CI-provisioning path is still an open choice.
    // `seedAiTaskDefault` is CREATE-ONLY, so this only decides a COLD seed.
    modelSlug: 'lms-gemma-4-e4b',
  },
];

export const seedAiTaskDefault = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiTaskDefault rows (TASK-506)...');

  let created = 0;
  let skipped = 0;
  for (const row of SYSTEM_AI_TASK_DEFAULTS) {
    const existing = await client.aiTaskDefault.findFirst({
      where: { tenantId: row.tenantId, taskKey: row.taskKey },
    });

    if (existing) {
      // CREATE-ONLY — never overwrite an admin-managed default.
      console.log(`  AiTaskDefault "${row.taskKey}" already exists, skipping`);
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
        createdBy: SYSTEM_USER_ID,
      },
    });
    created += 1;
  }

  console.log(`Seeded AiTaskDefault: ${created} created, ${skipped} skipped`);
  return { success: true, created, skipped };
};
