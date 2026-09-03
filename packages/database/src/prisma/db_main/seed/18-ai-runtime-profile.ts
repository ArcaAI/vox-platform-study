import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID } from './00-constants';
import { Prisma } from '../../../generated/core-prisma-client/client';

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
 * ## Round 5 lane B — re-examined, and the emptiness CONFIRMED
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
  /** Engine-specific ride-along (`extra_body` on the OpenAI-compatible family). */
  extraJson: Record<string, unknown> | null;
}

/**
 * Still NO limits — every numeric knob below is null, so `hasOpinion` stays false
 * and nothing here claims a measured quota (see the file header).
 *
 * the one row that ships is an ENGINE EXTRA paired with a seeded
 * catalog row, not a limit: gemma-4 runs with LM Studio's thinking mode ON by
 * default, which costs every realtime node 400–1300 reasoning tokens and blows
 * its budget on any GPU this platform targets. `reasoning_effort: "none"` is the
 * switch LM Studio honours on the OpenAI wire (verified 2026-09-03: 11 completion
 * tokens, 0 reasoning tokens, correct output). It rides `extraJson` → the
 * gateway's `applyTextRuntimeProfile` → TEXT `extra` → `extra_body`. A platform
 * admin can edit or delete it in the console; the seed is create-only.
 */
export const SYSTEM_AI_RUNTIME_PROFILES: AiRuntimeProfileSeed[] = [
  {
    id: '88000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    provider: 'lm-studio',
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    temperature: null,
    topP: null,
    maxTokens: null,
    contextLength: null,
    maxConcurrent: null,
    tpmLimit: null,
    rpmLimit: null,
    timeoutS: null,
    keepAliveSeconds: null,
    extraJson: { reasoning_effort: 'none' },
  },
];

export const seedAiRuntimeProfile = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiRuntimeProfile rows ...');

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

    const { extraJson, ...columns } = row;
    await client.aiRuntimeProfile.create({
      data: { ...columns, extraJson: extraJson === null ? Prisma.JsonNull : (extraJson as Prisma.InputJsonValue) },
    });
    created += 1;
  }

  console.log(
    `Seeded AiRuntimeProfile: ${created} created, ${skipped} skipped ` +
      '(empty by design — absence means "no opinion", so services keep their env defaults)',
  );
  return { success: true, created, skipped };
};
