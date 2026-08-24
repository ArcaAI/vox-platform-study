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
 * A super admin creates profiles deliberately through
 * `PUT /api/v1/admin/ai-runtime-profiles`; the seed never presumes one.
 *
 * The typed export exists so the seed-shape test can assert the emptiness
 * invariant, and so a future ticket that DOES need a shipped default has an
 * obvious, reviewed place to add it.
 *
 * ## TASK-799 Round 5 lane B — re-examined, and the emptiness CONFIRMED
 *
 * The proposal was to seed SYSTEM rows here by transcribing each consuming
 * service's in-code floor verbatim, on the theory that Phase 2 migrated
 * per-provider capacity and tuning onto this table and so left the Phase 4
 * admin editor with nothing to govern. Checked against the code, that theory is
 * wrong in a way that makes the seeding actively harmful. Three findings, each
 * independently sufficient:
 *
 * 1. **Phase 2 did not migrate the hyperparameters here.** `temperature` /
 *    `maxTokens` / `topP` went to `global-kv` REGISTRY keys —
 *    `text.generation.*` in `settings-registry/descriptors/text-generation.descriptors.ts`
 *    — which do have a write lane, a cascade, an invalidation channel and a
 *    Phase 4 screen. The governance surface exists; it is simply not this table.
 *
 * 2. **A row here would make that surface UNREACHABLE.** The order is: request
 *    value → `AiRuntimeProfile` → platform generation profile (pull) → in-code
 *    floor. The gateway writes profile values onto the request BODY
 *    (`TextRequestEnrichmentService.applyTextRuntimeProfile`), and `apps/text`
 *    applies `text.generation.*` only to fields the body OMITS — its own header
 *    says so: "a request that carried a profile never reaches the fallback
 *    below" (`apps/text/src/text/core/defaults.py`). So a SYSTEM profile row
 *    would silently pin every request to the seeded number and quietly disable
 *    the admin screen for those keys. That is the opposite of behaviour-neutral.
 *
 * 3. **The capacity values are FLOORS, and a floor is not a value to transcribe.**
 *    `apps/text/src/text/core/runtime_defaults.py` opens by declaring itself
 *    "deliberately not configuration… never the intended operating value", and
 *    explains that `tpm`/`rpm` are 0 precisely because "a non-zero guess would
 *    silently throttle a vendor account whose real quota nobody told us".
 *    Copying those numbers here would convert "the platform has no opinion" into
 *    "the platform has declared this limit" — a claim nobody made. It is not even
 *    observationally neutral: `EffectiveConfigService.hasOpinion` flips the
 *    served `source` from `env-fallback` to `db`, which is exactly the signal an
 *    operator reads to see that a provider is unprofiled.
 *
 * The right shipped default for this table is therefore still NONE. What belongs
 * in a row here is a value someone MEASURED for a specific `(provider, model)` —
 * a vendor's real quota, a profiled latency budget — which is per-deployment
 * knowledge a seed cannot have.
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
