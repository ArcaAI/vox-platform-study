/**
 * SYSTEM TenantTtsConfig default seed (TASK-577, finding F1)
 *
 * Creates the ONE row that makes the Day-1 TTS routing default admin-managed DB
 * data rather than a code/env vendor order: the SYSTEM-tenant `TenantTtsConfig`.
 * It is the missing tier of the resolution order the model already declares —
 * `tenant row → SYSTEM default → code default` (`TenantTtsConfigService.getEffective`) —
 * the tier that lets a tenant with no config of its own resolve a concrete,
 * BUILT-IN routing chain.
 *
 * OD-2 (CONFIRMED 2026-07-28) — built-in-first: English routes to the platform's
 * local Kokoro engine, Malayalam to the local Indic Parler engine. No cloud
 * vendor (azure / sarvam) is the implicit Day-1 default; cloud providers are
 * tenant-configured BYO only. The provider ids match the tts router's ids
 * (`apps/tts/src/tts/routing/router.py`; the built-in engines declare
 * `metaData.ttsProvider` = `kokoro` / `indic_parler` on their `AiModel` catalog
 * rows, seeded by `ai-models/tts.ts`).
 *
 * The `allowedProviders` whitelist lists every provider the platform can serve
 * so a tenant admin may later route to a BYO cloud provider; the DEFAULT routing
 * chains stay built-in only. Sarvam is whitelisted but stays gated behind the
 * per-tenant `sarvamPublicApiAllowed` PHI toggle (default off; the resolver
 * strips it from routing until enabled).
 *
 * Idempotent. CREATE-ONLY: an existing row is left untouched, because after the
 * first boot it is the global admin's to edit and a re-seed must never silently
 * revert an operator's change (mirrors `seedPlatformStorageConfig`).
 */
import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/** Stable id so a re-seed and a manual inspection can both find the row. */
export const SYSTEM_TENANT_TTS_CONFIG_ID = '00000000-0000-0000-0006-000000000001';

/**
 * The providers the platform can serve. Mirrors `PLATFORM_TTS_LIMITS.providerUniverse`
 * in `packages/applications/.../tenant-tts-config/platform-limits.ts` (the
 * database package must not depend on `@arcaai/applications`, so it is restated
 * here and locked by the seed test).
 */
export const PLATFORM_TTS_PROVIDER_UNIVERSE = ['azure', 'sarvam', 'kokoro', 'indic_parler', 'indic_f5'] as const;

/**
 * The SYSTEM-tenant platform-default TTS spec (built-in-first, OD-2). Exported so
 * the static seed test can lock its shape without a live DB.
 */
export const SYSTEM_TENANT_TTS_CONFIG = {
  id: SYSTEM_TENANT_TTS_CONFIG_ID,
  tenantId: SYSTEM_TENANT_ID,
  // Built-in-first routing: local engines only. A tenant BYO-configures cloud.
  routingEn: ['kokoro'] as string[],
  routingMl: ['indic_parler'] as string[],
  // Everything the platform can serve — routing is clamped to this, and a tenant
  // admin may route to a BYO cloud provider from here. Excludes indic_f5 (gated
  // OFF, prod NO-GO). Sarvam stays behind the sarvamPublicApiAllowed toggle.
  allowedProviders: ['kokoro', 'indic_parler', 'azure', 'sarvam'] as string[],
  createdBy: SYSTEM_USER_ID,
} as const;

export const seedTenantTtsConfig = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding SYSTEM TTS config default (built-in-first routing)...');
  try {
    const existing = await client.tenantTtsConfig.findFirst({
      where: { tenantId: SYSTEM_TENANT_ID, resourceStatus: { not: 'DELETED' } },
    });

    if (existing) {
      console.log(`SYSTEM TTS config already present (id=${existing.id}) — left untouched (operator-owned)`);
      return;
    }

    await client.tenantTtsConfig.create({
      data: {
        id: SYSTEM_TENANT_TTS_CONFIG.id,
        tenantId: SYSTEM_TENANT_TTS_CONFIG.tenantId,
        routingEn: SYSTEM_TENANT_TTS_CONFIG.routingEn,
        routingMl: SYSTEM_TENANT_TTS_CONFIG.routingMl,
        allowedProviders: SYSTEM_TENANT_TTS_CONFIG.allowedProviders,
        createdBy: SYSTEM_TENANT_TTS_CONFIG.createdBy,
      },
    });

    console.log(
      `Seeded SYSTEM TTS config default (routingEn=${SYSTEM_TENANT_TTS_CONFIG.routingEn.join(',')}, ` +
        `routingMl=${SYSTEM_TENANT_TTS_CONFIG.routingMl.join(',')})`,
    );
  } catch (error) {
    console.error('Error seeding SYSTEM TTS config default:', error);
    throw error;
  }
};
