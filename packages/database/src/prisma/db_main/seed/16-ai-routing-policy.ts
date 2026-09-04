/**
 * SYSTEM task-default ELECTIONS on `AiRoutingPolicy` (TASK-862).
 *
 * Replaces `16-ai-task-default.ts`: the `AiTaskDefault` table is retired
 * (deprecation register, R3) and nothing reads it any more — `apps/guardrail`
 * and `AiTaskDefaultService` both resolve the elected `isDefault = true`
 * `AiRoutingPolicy` row per `(SYSTEM, taskKey)`. This seed writes exactly those
 * rows, so a cold database answers "which model serves task X" on day 1.
 *
 * One row per task key, CREATE-ONLY: an existing elected default for a key is
 * never overwritten (an admin's runtime election survives a re-seed). The
 * model is bound by FK (`modelId`), resolved from the SYSTEM catalogue by slug
 * at seed time; a slug that resolves to nothing is SKIPPED with a warning — the
 * task then fails closed (503) rather than pointing at a phantom.
 *
 * `providerConnectionId` is left NULL: a configuration served by no provider
 * connection (an in-process `apps/nlp` model, the platform's own LM Studio)
 * resolves as platform-funded in `AiRoutingPolicyService.fundRow`, exactly as
 * the retired `AiTaskDefault` rows did.
 *
 * TASK-860 supersedes the DATA here with the registry's "platform default for
 * task" election (`setDefault` from `/ai-models`); until that merges this list
 * is the day-1 posture, carried over verbatim from the retired seed.
 */
import type { AiTaskKind } from '../../../generated/core-prisma-client/enums';
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * `taskKey` → `taskKind`, mirrored from `AI_TASK_KIND_BY_TASK_KEY` in the
 * applications layer (the seed cannot import from it). `?? null` is
 * fail-closed — an unrecognised key stays unclassified rather than guessed.
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

export interface TaskDefaultRoutingSeed {
  /** Deterministic `AiRoutingPolicy.id` for the SYSTEM elected default. */
  id: string;
  tenantId: string;
  taskKey: string;
  /** SYSTEM catalogue slug; resolved to `modelId` at seed time. */
  modelSlug: string;
}

/**
 * Task keys that DELIBERATELY have no SYSTEM default, with the reason. Kept
 * from the retired seed so the intent survives: absence here is a posture, not
 * a gap.
 */
export const SYSTEM_TASK_DEFAULT_EXEMPTIONS: Record<string, string> = {
  'text.live.fallback': 'Opt-in per-tenant fallback (fail-open): a SYSTEM row would switch a second provider on for every tenant and bill them for it.',
  'text.finalize.fallback': 'Opt-in per-tenant fallback, identical reasoning to `text.live.fallback`.',
  'vlm.extract': 'No deployable vision model is loaded on the LM Studio instance; a SYSTEM default would replace a clean 503 with an upstream 404.',
  'nlp.sentiment': 'No checkpoint has been selected and no gateway route reaches the key — an OPEN OWNER DECISION.',
  'nlp.toxicity': 'No checkpoint has been selected (multi-label, needs a per-label head + `labelTaxonomy.cls_threshold`) — an OPEN OWNER DECISION.',
};

/** The twelve SYSTEM elected defaults — carried over verbatim from the retired `16-ai-task-default.ts`. */
export const SYSTEM_TASK_DEFAULT_ROUTING: TaskDefaultRoutingSeed[] = [
  { id: '89000000-0000-0000-0000-000000000001', tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.validate', modelSlug: 'granite-guardian-4.1-8b' },
  { id: '89000000-0000-0000-0000-000000000002', tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.ner', modelSlug: 'medical-ner' },
  // The `/classify/text` document-type classifier — an explicitly DISABLED
  // placeholder until a real doc-type model is seeded (fails closed).
  { id: '89000000-0000-0000-0000-000000000003', tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.classification', modelSlug: 'nlp-doc-type-classifier' },
  { id: '89000000-0000-0000-0000-000000000009', tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.diagnosis', modelSlug: 'symps-disease-bert-v3-c41' },
  // OWNER DIRECTIVE 2026-09-03: every text-generation task routes to LM Studio
  // `gemma-4-e2b-it-qat` (registry slug `lms-gemma-4-e2b-it-qat`).
  { id: '89000000-0000-0000-0000-000000000004', tenantId: SYSTEM_TENANT_ID, taskKey: 'text.live', modelSlug: 'lms-gemma-4-e2b-it-qat' },
  { id: '89000000-0000-0000-0000-000000000005', tenantId: SYSTEM_TENANT_ID, taskKey: 'text.finalize', modelSlug: 'lms-gemma-4-e2b-it-qat' },
  { id: '89000000-0000-0000-0000-000000000010', tenantId: SYSTEM_TENANT_ID, taskKey: 'text.test', modelSlug: 'lms-gemma-4-e2b-it-qat' },
  { id: '89000000-0000-0000-0000-000000000006', tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.safety', modelSlug: 'gliguard-llm-guardrails-300m' },
  { id: '89000000-0000-0000-0000-000000000011', tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.pii', modelSlug: 'gliner2-privacy-filter-pii-multi' },
  { id: '89000000-0000-0000-0000-000000000012', tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.pii.spans', modelSlug: 'gliner2-guardrails-pii-multi' },
  { id: '89000000-0000-0000-0000-000000000007', tenantId: SYSTEM_TENANT_ID, taskKey: 'guardrail.groundedness', modelSlug: 'minicheck-flan-t5-large' },
  { id: '89000000-0000-0000-0000-000000000008', tenantId: SYSTEM_TENANT_ID, taskKey: 'harness.judge', modelSlug: 'lms-gemma-4-e2b-it-qat' },
];

export const seedAiRoutingPolicy = async (
  client: CorePrismaClient,
): Promise<{ success: true; created: number; skipped: number; unresolved: number }> => {
  console.log('Seeding SYSTEM AiRoutingPolicy elected defaults ...');

  let created = 0;
  let skipped = 0;
  let unresolved = 0;
  for (const row of SYSTEM_TASK_DEFAULT_ROUTING) {
    const elected = await client.aiRoutingPolicy.findFirst({
      where: { tenantId: row.tenantId, taskKey: row.taskKey, isDefault: true, resourceStatus: { not: 'DELETED' } },
    });
    if (elected) {
      // CREATE-ONLY — never overwrite an admin's runtime election.
      console.log(`  AiRoutingPolicy default for "${row.taskKey}" exists (${elected.id}) — KEPT AS IS`);
      skipped += 1;
      continue;
    }

    const model = await client.aiModel.findFirst({
      where: { tenantId: SYSTEM_TENANT_ID, slug: row.modelSlug, resourceStatus: 'ENABLED' },
      select: { id: true, slug: true },
    });
    if (!model) {
      console.warn(`  ⚠️  "${row.taskKey}" → ${row.modelSlug}: no ENABLED SYSTEM AiModel carries that slug — NOT seeded (the task fails closed)`);
      unresolved += 1;
      continue;
    }

    console.log(`  Electing AiRoutingPolicy default "${row.taskKey}" → ${row.modelSlug} (${model.id})`);
    await client.aiRoutingPolicy.create({
      data: {
        id: row.id,
        tenantId: row.tenantId,
        taskKey: row.taskKey,
        taskKind: AI_TASK_KIND_BY_SEEDED_TASK_KEY[row.taskKey] ?? null,
        displayName: model.slug,
        modelId: model.id,
        isDefault: true,
        enabled: true,
        // ACTIVE, not DRAFT: a platform default serves the moment it is seeded.
        status: 'ACTIVE',
        activatedAt: new Date(),
        createdBy: SYSTEM_USER_ID,
      },
    });
    created += 1;
  }

  console.log(`Seeded AiRoutingPolicy defaults: ${created} created, ${skipped} skipped, ${unresolved} unresolved`);
  if (skipped > 0) {
    console.warn(
      `⚠️  ${skipped} elected default(s) already existed and were NOT UPDATED. This phase is create-only by design — ` +
        'a re-seed must never clobber a model election an admin made at runtime. Re-elect through ' +
        'POST /api/v1/admin/ai-routing-policies/:id/default, or delete the row first and re-seed.',
    );
  }
  return { success: true, created, skipped, unresolved };
};
