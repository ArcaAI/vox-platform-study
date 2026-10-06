/**
 * TASK-1048 (owner decision OD-2, 2026-10-06) — the platform default speaker-embedding model.
 *
 * Registry key `stt.diarization.defaultEmbeddingModelSlug` (the frozen contract constant
 * `STT_DIARIZATION_DEFAULT_EMBEDDING_MODEL_SETTING_KEY` in `@arcaai/types`). The gateway consults it
 * only when a speech-to-text agent enables speaker diarization and names no
 * `audioFrontEnd.diarization.embeddingModelSlug`; tenant → SYSTEM, widened on ABSENCE only.
 *
 * WHY A SEEDED ROW AND NOT A DESCRIPTOR DEFAULT. It is model SELECTION, so its descriptor is
 * `failMode: 'closed'` with NO code default (rule 09 §Configuration Tiers) — exactly the shape of
 * `identity.autoProvision.roleId`. This SYSTEM row IS the platform value. Without it the setting is
 * unresolved and every agent in that state diarizes nothing (the session still runs and reports
 * `DIARIZATION_MODEL_MISSING`), which is the fail-safe direction.
 *
 * ROW COORDINATES ARE LOAD-BEARING (the same rule `11c-consultation-gate-settings.ts` spells out).
 * `SettingsRegistryWriteService` finds an existing platform row by `(key, namespace='registry',
 * tenantId=SYSTEM)` and, failing that, CREATES one named after `descriptor.label`. `GlobalSetting`
 * is unique on `(tenantId, name, key)`, so a different tenant, namespace or name would make an
 * operator's first `PUT` create a SECOND platform row, which `AppSettingsService` refuses to boot
 * on. `stt-runtime.descriptors.test.ts` in `@arcaai/applications` pins key, name, value and tenant,
 * because `packages/database` must not depend on `@arcaai/applications`.
 *
 * IDEMPOTENT and CREATE-ONLY for `value`: a re-seed refreshes metadata but never clobbers an
 * operator's choice (`seed/__tests__/seed-idempotency.test.ts`). Changing it afterwards is one call:
 *   PUT /api/v1/admin/settings/registry/stt.diarization.defaultEmbeddingModelSlug { "value": "<slug>" }
 */
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_USER_IDS, SYSTEM_TENANT_ID } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/** The namespace `SettingsRegistryWriteService` stamps on every registry row. */
const NAMESPACE = 'registry';

/** The one row. `name` must equal the descriptor's `label` verbatim (row identity). */
export const STT_DIARIZATION_DEFAULT_SETTING = {
  key: 'stt.diarization.defaultEmbeddingModelSlug',
  name: 'Default speaker-embedding model',
  // The SYSTEM SPEAKER_EMBEDDING row seeded by `ai-models/` — 256-d WeSpeaker ResNet34.
  value: 'wespeaker-voxceleb-resnet34',
  description:
    'Platform default speaker-embedding model (TASK-1048 OD-2): used by a speech-to-text agent that enables speaker diarization ' +
    'but names no embeddingModelSlug of its own. A tenant may set its own; this SYSTEM value is the fallback for tenants with no ' +
    'opinion. Unset or unresolvable, diarization is switched off for the session (DIARIZATION_MODEL_MISSING) and transcription still runs.',
} as const;

export const seedSttDiarizationDefaultSetting = async (client: CorePrismaClient): Promise<void> => {
  const row = STT_DIARIZATION_DEFAULT_SETTING;
  await client.globalSetting.upsert({
    where: {
      GlobalSetting_tenantId_name_key_unique: {
        tenantId: SYSTEM_TENANT_ID,
        name: row.name,
        key: row.key,
      },
    },
    // Idempotent: refresh code-owned metadata, never the operator-owned `value`.
    update: {
      defaultValue: row.value,
      dataType: ValueType.String,
      description: row.description,
      namespace: NAMESPACE,
    },
    create: {
      tenantId: SYSTEM_TENANT_ID,
      namespace: NAMESPACE,
      name: row.name,
      key: row.key,
      value: row.value,
      defaultValue: row.value,
      dataType: ValueType.String,
      description: row.description,
      locked: false,
      createdBy: CREATED_BY,
    },
  });
  console.log(`  ${NAMESPACE}/${row.key} → ${row.value} on create (existing value preserved)`);
};
