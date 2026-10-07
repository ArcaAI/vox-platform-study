import type { CorePrismaClient } from '../../../client';
import { ResourceStatusType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';
import { AUDIO_AI_MODELS } from './ai-models/audio';
import { withCapabilityMetadata } from './ai-models/capabilities';
import { LLM_AI_MODELS } from './ai-models/llm';
import { NLP_AI_MODELS } from './ai-models/nlp';
import { TTS_AI_MODELS } from './ai-models/tts';
import { RETIRED_AI_MODEL_SLUGS, shouldRetireAiModelSlug } from './ai-models/retired';
import type { AiModelSeed } from './ai-models/shared';

/**
 * AI Model Registry seed (TASK-860) — the platform catalogue of the shared
 * `hope-models` bucket, organised by Hugging Face task.
 *
 * Split out of `06-stt.ts` so the pipeline half can be deleted by TASK-861
 * without touching the catalogue. Every row is PLATFORM-WIDE: owned by the
 * reserved SYSTEM tenant (`00000000-…`), read by every customer tenant through
 * the tenant-scope extension's shared-read widening, and NEVER cloned — the
 * `backfillCustomerTenantAiModels` step that used to materialise per-tenant
 * copies is gone, and `retireCustomerTenantAiModels` below sweeps any copy an
 * older seed left behind.
 *
 * Order inside `seedAiModelRegistry`: upsert the catalogue → retire the ledger
 * slugs (guarded by live Agent bindings, TASK-966) → retire every
 * non-SYSTEM row. Idempotent end to end; `db:seed` re-runs write nothing new.
 */

export { AiDeploymentKind, AiModelAvailability, AiTaskKind, AI_MODEL_LIBRARIES, AI_MODEL_SERVED_BY } from './ai-models/shared';
export type { AiModelLibrary, AiModelServedBy } from './ai-models/shared';
export { AUDIO_AI_MODELS } from './ai-models/audio';
export { LLM_AI_MODELS } from './ai-models/llm';
export { NLP_AI_MODELS } from './ai-models/nlp';
export { TTS_AI_MODELS } from './ai-models/tts';
export { RETIRED_AI_MODEL_SLUGS, shouldRetireAiModelSlug, pipelineYamlReferencesSlug } from './ai-models/retired';

/**
 * The platform catalogue — exactly the owner's 35 rows (README §3.6):
 * 20 audio (13 ASR, 1 VAD, 2 denoisers, 2 speaker embeddings, Cadence),
 * 6 text-generation, 6 NLP, 4 TTS. Nothing else; everything the previous
 * catalogue carried beyond this is in `RETIRED_AI_MODEL_SLUGS`.
 */
export const DEFAULT_AI_MODELS: AiModelSeed[] = withCapabilityMetadata([...AUDIO_AI_MODELS, ...LLM_AI_MODELS, ...NLP_AI_MODELS, ...TTS_AI_MODELS]);

type SeedMetaData = NonNullable<AiModelSeed['metaData']>;

/** `_metadata` keys whose CURRENT value a platform admin edits (W2h); the seed never overwrites them. */
const ADMIN_EDITABLE_METADATA_KEYS = ['policy', 'judge'] as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * TASK-1050 (README §11.3 C, OD-33) — the `metaData` an UPDATE of an existing row writes. Pure.
 *
 * `policy` and `judge` are admin-editable CURRENT values (`/guardrails/control`, W2h), so a re-seed keeps the
 * stored object and only ADDS the top-level keys the seed declares and the row lacks, at the seed value —
 * which is how a new criteria key or band reaches an existing database. A key the row has and the seed does
 * not is kept too: the seed never deletes an admin's value. A row with no stored object (or a malformed one)
 * takes the seed's whole. `policyDefaults` / `judgeDefaults` are seed-owned factory defaults and are
 * refreshed to the seed. Every other key keeps the full-column behaviour this function replaced: the seed
 * blob is written as declared, so a key only the row carries is dropped.
 *
 * The merge is one level deep on purpose: a nested object (`judgeBands`, `categoryMap`) is one admin-edited
 * value, so an entry an admin removed from it is not re-added by a re-seed.
 *
 * `labelTaxonomy` is the seed's, with the stored classifier thresholds kept ({@link mergeLabelTaxonomy});
 * `labelTaxonomyDefaults` is refreshed to the seed.
 */
export function mergeSeedMetaDataForUpdate(existing: unknown, seed: SeedMetaData): SeedMetaData {
  const stored = isPlainObject(existing) ? existing : {};
  const merged: Record<string, unknown> = { ...seed };
  for (const key of ADMIN_EDITABLE_METADATA_KEYS) {
    const current = stored[key];
    const fromSeed = seed[key];
    if (!isPlainObject(current)) {
      if (fromSeed !== undefined) merged[key] = structuredClone(fromSeed);
      continue;
    }
    merged[key] = structuredClone({ ...(isPlainObject(fromSeed) ? fromSeed : {}), ...current });
  }
  if (seed.labelTaxonomy !== undefined) merged.labelTaxonomy = mergeLabelTaxonomy(stored.labelTaxonomy, seed.labelTaxonomy);
  return merged as SeedMetaData;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * TASK-1050 (W2h round 2) — `labelTaxonomy` on UPDATE: the seed's taxonomy (labels, the task set,
 * `benignLabels`, `multi_label` are MODEL FACTS), carrying over the two admin-editable thresholds from the stored
 * row: the top-level `threshold`, and `tasks.<task>.cls_threshold` for every task the seed still declares. A task
 * new in the seed, or a stored threshold that is not a finite number, takes the seed value. `labelTaxonomyDefaults`
 * is not handled here: it is written from the seed like any other key.
 */
function mergeLabelTaxonomy(stored: unknown, seed: NonNullable<SeedMetaData['labelTaxonomy']>): NonNullable<SeedMetaData['labelTaxonomy']> {
  const merged = structuredClone(seed);
  if (!isPlainObject(stored)) return merged;
  if (isFiniteNumber(stored.threshold)) merged.threshold = stored.threshold;
  const storedTasks = isPlainObject(stored.tasks) ? stored.tasks : {};
  for (const [task, spec] of Object.entries(merged.tasks ?? {})) {
    const storedTask = storedTasks[task];
    if (isPlainObject(storedTask) && isFiniteNumber(storedTask.cls_threshold)) spec.cls_threshold = storedTask.cls_threshold;
  }
  return merged;
}

/**
 * Upsert the catalogue. NOT create-only: every registry column the seed
 * declares is re-synced on re-seed, so a catalogue correction propagates
 * (`metaData` — voices, label taxonomies, calibration — included; it is
 * written only when the seed row declares one). TASK-1050: the admin-editable
 * `metaData.policy` / `metaData.judge` are merged, not overwritten — see
 * {@link mergeSeedMetaDataForUpdate}. A CREATE writes the seed row verbatim.
 *
 * Deliberately NOT re-synced: `resourceStatus` (an admin's enable/disable
 * decision survives), `availability` unless the seed pins NOT_APPLICABLE (a
 * measured value must never be reset to UNKNOWN by a seed), and the
 * publisher-owned bucket identity (`bucketPrefix`, `primaryObject`,
 * `manifestDigest`, `hfRevision`).
 */
export const seedAiModels = async (client: CorePrismaClient) => {
  console.log('Seeding AI Model Registry...');

  for (const modelData of DEFAULT_AI_MODELS) {
    const existing = await client.aiModel.findFirst({
      where: {
        tenantId: modelData.tenantId,
        slug: modelData.slug,
      },
    });

    if (existing) {
      console.log(`  AI Model "${modelData.slug}" already exists, updating...`);
      await client.aiModel.update({
        where: { id: existing.id },
        data: {
          name: modelData.name,
          description: modelData.description,
          category: modelData.category,
          taskType: modelData.taskType,
          modelType: modelData.modelType,
          source: modelData.source,
          sourceUri: modelData.sourceUri,
          sourceRevision: modelData.sourceRevision,
          format: modelData.format,
          libraryName: modelData.libraryName,
          servedBy: modelData.servedBy,
          deploymentKind: modelData.deploymentKind,
          wireModelId: modelData.wireModelId ?? null,
          license: modelData.license ?? null,
          gated: modelData.gated ?? false,
          baseModel: modelData.baseModel ?? null,
          languages: modelData.languages ?? [],
          isPlatformDefaultFor: modelData.isPlatformDefaultFor ?? [],
          ...(modelData.availability !== undefined ? { availability: modelData.availability } : {}),
          memorySizeMb: modelData.memorySizeMb,
          computeType: modelData.computeType,
          tags: modelData.tags,
          provider: modelData.provider,
          architecture: modelData.architecture,
          ...(modelData.metaData !== undefined ? { metaData: mergeSeedMetaDataForUpdate(existing.metaData, modelData.metaData) } : {}),
        },
      });
    } else {
      console.log(`  Creating AI Model "${modelData.slug}"...`);
      await client.aiModel.create({
        data: modelData,
      });
    }
  }

  console.log(`Seeded ${DEFAULT_AI_MODELS.length} AI Models`);
  return { success: true, count: DEFAULT_AI_MODELS.length };
};

/**
 * Soft-retire the ledger slugs (`RETIRED_AI_MODEL_SLUGS`) across EVERY
 * tenant's copy (SYSTEM master + any clone an older seed or tenant
 * provisioning left behind). Runs AFTER the upserts.
 *
 * Idempotent: rows already `DELETED` are excluded by the filter, so re-running
 * `db:seed` writes nothing. Soft-delete only — rows stay recoverable.
 *
 * TASK-966 — the guard reads every non-deleted `Agent`'s `parameters`
 * and `compiledConfig`: a PUBLISHED agent version is immutable (DB trigger), so a
 * slug it binds (e.g. `postProcessing.punctuation.modelSlug`) cannot be migrated
 * by this seed, and retiring the row would turn every resolution of that agent
 * into `AgentResolverService`'s 409 ("references … model, which is not visible").
 * Such a slug stays active until an admin publishes a version that no longer
 * names it; a fresh database never creates the row in the first place. The
 * pure decision is `shouldRetireAiModelSlug` (seed/ai-models/retired.ts).
 *
 * TASK-1006 — the sibling `AsrPipeline.configYaml` guard input is GONE with
 * the table: the pipeline surface that could hold a custom-built reference to
 * one of these slugs no longer exists, so an agent binding is the only thing
 * that can still keep a slug alive.
 */
export const retireLegacyAiModels = async (client: CorePrismaClient): Promise<{ retired: number; skipped: string[] }> => {
  console.log('Retiring legacy AI models (catalogue ledger)...');

  // Guard input: every non-deleted agent version's bound configuration, ANY tenant (TASK-966).
  // Serialised JSON is a valid input for the slug-boundary regex: a bound slug sits between
  // quotes, which are outside `SLUG_BOUNDARY_CHARSET`.
  const activeAgents = await client.agent.findMany({
    where: { resourceStatus: { not: ResourceStatusType.DELETED } },
    select: { parameters: true, compiledConfig: true },
  });
  const activeReferences = activeAgents
    .flatMap((agent) => [agent.parameters, agent.compiledConfig])
    .filter((value) => value != null)
    .map((value) => JSON.stringify(value));

  let retired = 0;
  const skipped: string[] = [];
  for (const slug of RETIRED_AI_MODEL_SLUGS) {
    if (!shouldRetireAiModelSlug(slug, activeReferences)) {
      console.warn(
        `  ⚠️  RETIREMENT SKIPPED: AiModel "${slug}" is still referenced by a ` +
          'non-deleted Agent version — leaving it active. ' +
          'Publish an agent version off this model, then re-run db:seed.',
      );
      skipped.push(slug);
      continue;
    }

    // Sweep ALL tenants' copies of the slug in one statement.
    const result = await client.aiModel.updateMany({
      where: { slug, resourceStatus: { not: ResourceStatusType.DELETED } },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    retired += result.count;
  }

  console.log(
    `Retired ${retired} legacy AI model rows across all tenants` +
      (skipped.length > 0 ? ` (${skipped.length} slugs skipped: ${skipped.join(', ')})` : ''),
  );
  return { retired, skipped };
};

/**
 * Registry rows are SYSTEM-only (TASK-860 R-1). Soft-delete every row that
 * lives in any OTHER tenant — the customer-tenant clones the previous seed
 * materialised, and anything registered directly into a tenant before the
 * service pinned writes to SYSTEM. Matches by tenant, not slug: a copy the
 * platform no longer recognises is retired whatever it was called.
 *
 * Idempotent (already-DELETED rows are excluded); soft-delete only, because
 * `AiRoutingPolicy.modelId` is `onDelete: Restrict` and nothing in this
 * platform is ever hard-deleted. The SQL twin lives in the TASK-860 migration
 * for environments that arrive via `migrate deploy`.
 */
export const retireCustomerTenantAiModels = async (client: CorePrismaClient): Promise<{ retired: number }> => {
  console.log('Retiring non-SYSTEM AI model rows (registry is SYSTEM-only)...');

  const result = await client.aiModel.updateMany({
    where: {
      tenantId: { not: SYSTEM_TENANT_ID },
      resourceStatus: { not: ResourceStatusType.DELETED },
    },
    data: {
      resourceStatus: ResourceStatusType.DELETED,
      resourceStatusUpdatedAt: new Date(),
      resourceStatusUpdatedBy: SYSTEM_USER_ID,
      version: { increment: 1 },
    },
  });

  console.log(`Retired ${result.count} non-SYSTEM AI model rows`);
  return { retired: result.count };
};

/**
 * Main seed function for the model registry: upsert → ledger retirement →
 * non-SYSTEM sweep. Called from `seed/index.ts` BEFORE `seedStt`.
 */
export const seedAiModelRegistry = async (client: CorePrismaClient) => {
  console.log('Starting AI Model Registry seeding...\n');

  try {
    await seedAiModels(client);
    console.log('');

    await retireLegacyAiModels(client);
    console.log('');

    await retireCustomerTenantAiModels(client);
    console.log('');

    console.log('AI Model Registry seeding completed successfully!');
    return { success: true };
  } catch (error) {
    console.error('Error during AI Model Registry seeding:', error);
    throw error;
  }
};
