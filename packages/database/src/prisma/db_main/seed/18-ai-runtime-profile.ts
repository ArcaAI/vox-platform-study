import type { CorePrismaClient } from '../../../client';

/**
 * AiRuntimeProfile Seed (config-plane core)
 *
 * DELIBERATELY EMPTY — and that emptiness is the feature, not an omission.
 *
 * A runtime profile row expresses "the platform has an opinion about this
 * provider/model's hyperparameters". The injection cascade is:
 *
 *   explicit request params
 *     → AiTaskDefault.configJson
 *       → AiRuntimeProfile(SYSTEM, provider, modelSlug)
 *         → AiRuntimeProfile(SYSTEM, provider, "")
 *           → the consuming service's own pydantic/env default
 *
 * With ZERO rows seeded, every resolution falls straight through to the last
 * tier — so gateway-forwarded requests are byte-identical to today's. This is
 * a deliberate silent-change guard: seeding any value here would silently
 * override a live service default without the caller changing anything.
 *
 * A global admin creates profiles deliberately through
 * `PUT /api/v1/admin/ai-runtime-profiles`; the seed never presumes one.
 *
 * The typed export exists so the seed-shape test can assert the emptiness
 * invariant, and so a future ticket that DOES need a shipped default has an
 * obvious, reviewed place to add it.
 */

export interface AiRuntimeProfileSeed {
  id: string;
  tenantId: string;
  provider: string;
  /** `""` = provider-level default; otherwise an `AiModel.slug`. */
  modelSlug: string;
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxConcurrent: number | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  timeoutS: number | null;
  keepAliveSeconds: number | null;
}

/** Intentionally empty — see the file header. Ids would use the `88000000-…` block. */
export const SYSTEM_AI_RUNTIME_PROFILES: AiRuntimeProfileSeed[] = [];

export const seedAiRuntimeProfile = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiRuntimeProfile rows (TASK-524)...');

  let created = 0;
  let skipped = 0;
  for (const row of SYSTEM_AI_RUNTIME_PROFILES) {
    const existing = await client.aiRuntimeProfile.findFirst({
      where: { tenantId: row.tenantId, provider: row.provider, modelSlug: row.modelSlug },
    });

    if (existing) {
      // CREATE-ONLY — never clobber an admin-tuned profile.
      skipped += 1;
      continue;
    }

    await client.aiRuntimeProfile.create({ data: { ...row } });
    created += 1;
  }

  console.log(
    `Seeded AiRuntimeProfile: ${created} created, ${skipped} skipped ` +
      '(empty by design — absence means "no opinion", so services keep their env defaults)',
  );
  return { success: true, created, skipped };
};
