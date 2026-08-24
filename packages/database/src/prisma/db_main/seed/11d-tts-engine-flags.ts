/**
 * TTS Provider/Engine Enable-Flag Settings Seed (TASK-799 lane H)
 *
 * Gives the five `TTS_*_ENABLED` flags a home in the control plane, so which
 * engines `apps/tts` registers stops being a property of a ConfigMap in a
 * DIFFERENT GIT REPOSITORY (`arca/hope-v2-deployment`) and becomes a
 * SUPER_ADMIN write with an audit trail.
 *
 *   tts.azure.enabled     Azure AI Speech provider (cloud, BYOK)
 *   tts.sarvam.enabled    Sarvam Bulbul provider (cloud, BYOK)
 *   tts.kokoro.enabled    self-hosted Kokoro English engine  ← SEEDED ON
 *   tts.parler.enabled    self-hosted AI4Bharat Indic Parler (Malayalam)
 *   tts.indicf5.enabled   experimental IndicF5 voice clone (CC-BY-NC gated)
 *
 * WHY A SEEDED ROW AND NOT A DESCRIPTOR DEFAULT (for kokoro)
 * -----------------------------------------------------------
 * The descriptor default must equal the PYTHON FIELD default — that parity is
 * asserted verbatim by `apps/tts/.../test_task799_descriptor_parity.py`, and it
 * is what makes an unseeded deployment run on exactly the values it always ran
 * on. `KokoroConfig.enabled` is `False`, so the descriptor default is `false`.
 *
 * But `false` is not the platform's intent: the SYSTEM voice catalog routes
 * `en` to kokoro, kokoro ships in the DEFAULT image (not a `[local]` extra), and
 * `TTS_KOKORO_ENABLED=true` is what makes a KEYLESS deployment reach
 * `/health/ready` at all. `hope-tts` once answered 503 forever, so its Service
 * carried no endpoints and `TTS_URL` resolved to nothing — the outage
 * `test_keyless_readiness_task642.py` exists to prevent.
 *
 * So the split is:
 *
 *   descriptor default `false`  →  an unseeded deployment is unchanged
 *   the seeded ROW `'true'`     →  every seeded environment comes up serving
 *   `defaultValue` `'false'`    →  "reset to default" reverts to the code value
 *
 * which is the sanctioned pattern `11c-consultation-gate-settings.ts` uses for
 * the OCR gate, and `11-global-setting.ts` uses twice more.
 *
 * THE OTHER FOUR ARE SEEDED OFF, AND THAT IS NOT A NO-OP. A row exists, so a
 * platform admin can turn an engine on with one `PUT` instead of a manifest
 * change and a rollout — which is the entire point of the migration. It is also
 * behaviour-neutral against every environment that follows `.env.sample` and the
 * live ConfigMap, where all four are unset.
 *
 * ENV IS STILL THE BOOTSTRAP FALLBACK, DELIBERATELY. `apps/tts` keeps reading
 * `TTS_*_ENABLED`, and `control_plane.py#ENV_BOOTSTRAP_KEYS` declares env
 * SUBORDINATE: only a value a DATABASE ROW supplied (`source: 'db'`) overrides
 * it. Closing the env path is a THIRD step that must not land before the k8s
 * manifests stop setting these variables — see that module's docstring.
 *
 * ROW COORDINATES ARE LOAD-BEARING. `SettingsRegistryWriteService` finds an
 * existing row by `(key, namespace='registry', tenantId=SYSTEM)` and otherwise
 * CREATES one named `descriptor.label`; `GlobalSetting` is unique on
 * `(tenantId, name, key)`. Seed a different tenant, namespace or name and the
 * operator's first `PUT` creates a SECOND platform row for the same key, which
 * `AppSettingsService` refuses to boot on. `tts-engine-flag-seed-parity.test.ts`
 * in `@arcaai/applications` holds all four coordinates to the registry, because
 * `packages/database` must not depend on `@arcaai/applications`.
 *
 * IDEMPOTENT, and CREATE-ONLY for the `value` column: a re-seed refreshes
 * metadata but never clobbers an admin who turned an engine off. Enforced
 * repo-wide by `seed/__tests__/seed-idempotency.test.ts`.
 *
 * Flipping one afterwards is one call, no redeploy:
 *   PUT /api/v1/admin/settings/registry/tts.parler.enabled  { "value": true }
 */
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_USER_IDS } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/** The namespace `SettingsRegistryWriteService` stamps on every registry row. */
const NAMESPACE = 'registry';

interface EngineFlagSeed {
  /** Registry descriptor key. */
  key: string;
  /** Human label — must match the descriptor's `label` verbatim (row identity). */
  name: string;
  /** The platform's decision on a fresh database. */
  value: string;
  /** The Python/descriptor default, so "reset to default" returns the code value. */
  defaultValue: string;
  description: string;
}

const FLAGS: EngineFlagSeed[] = [
  {
    key: 'tts.kokoro.enabled',
    name: 'Kokoro engine enabled',
    // The one row seeded ON — see the header. Without it a keyless deployment
    // registers no provider and reports 503 on /health/ready.
    value: 'true',
    defaultValue: 'false',
    description:
      'Registers the self-hosted Kokoro English engine. The SYSTEM voice catalog routes `en` to kokoro and kokoro ships in the default image, so this is the flag a keyless deployment needs to become Ready. Weights load lazily on the first synthesis request, so enabling it costs nothing at boot. Bootstrap fallback TTS_KOKORO_ENABLED remains readable until the k8s manifests stop setting it.',
  },
  {
    key: 'tts.azure.enabled',
    name: 'Azure Speech provider enabled',
    value: 'false',
    defaultValue: 'false',
    description:
      'Registers the Azure AI Speech provider at boot. A registered cloud provider with no credential is still not a routing candidate — it would 401 the live API — so enabling it only makes Azure reachable to tenants that bring their own key. Bootstrap fallback TTS_AZURE_ENABLED.',
  },
  {
    key: 'tts.sarvam.enabled',
    name: 'Sarvam provider enabled',
    value: 'false',
    defaultValue: 'false',
    description:
      'Registers the Sarvam Bulbul provider. The PUBLIC Sarvam API is not PHI-safe (no BAA, 30-day retention, not India-resident) — point tts.sarvam.baseUrl at the enterprise VPC or on-prem host before enabling it for patient data. Bootstrap fallback TTS_SARVAM_ENABLED.',
  },
  {
    key: 'tts.parler.enabled',
    name: 'Indic Parler engine enabled',
    value: 'false',
    defaultValue: 'false',
    description:
      'Registers the self-hosted AI4Bharat Indic Parler-TTS Malayalam engine. Off by default: the weights are large and the image extra is not installed everywhere, so enable it only where the engine is actually present. Bootstrap fallback TTS_PARLER_ENABLED.',
  },
  {
    key: 'tts.indicf5.enabled',
    name: 'IndicF5 engine enabled (LICENSE-GATED)',
    // MUST stay off. This row is the point of the migration: the CC-BY-NC
    // restriction was previously enforced only by a code comment, and is now a
    // locked SUPER_ADMIN write with an audit trail.
    value: 'false',
    defaultValue: 'false',
    description:
      'Registers the experimental IndicF5 voice-clone engine. Production and commercial enablement are NO-GO pending license review: the released weights are a fine-tune of the CC-BY-NC SWivid F5-TTS base, and the MIT tag cannot override NonCommercial. Locked — only SUPER_ADMIN may change it, and the change is audited. Bootstrap fallback TTS_INDICF5_ENABLED.',
  },
];

export const seedTtsEngineFlagSettings = async (client: CorePrismaClient): Promise<void> => {
  console.log(`Seeding tts engine-flag Global Settings (${FLAGS.length} platform rows, namespace='${NAMESPACE}')...`);

  for (const flag of FLAGS) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: SYSTEM_TENANT_ID,
          name: flag.name,
          key: flag.key,
        },
      },
      // Idempotent: refresh code-owned metadata but NEVER clobber an operator
      // who turned an engine off — `value` is create-only.
      update: {
        defaultValue: flag.defaultValue,
        dataType: ValueType.Boolean,
        description: flag.description,
        namespace: NAMESPACE,
        locked: true,
      },
      create: {
        tenantId: SYSTEM_TENANT_ID,
        namespace: NAMESPACE,
        name: flag.name,
        key: flag.key,
        value: flag.value,
        defaultValue: flag.defaultValue,
        dataType: ValueType.Boolean,
        description: flag.description,
        locked: true,
        createdBy: CREATED_BY,
      },
    });
    // NB: reports what a FIRST seed writes. On a re-seed the `value` column is
    // deliberately left alone — do not read this line as "the row is now X".
    console.log(`  ${NAMESPACE}/${flag.key} → ${flag.value} on create (default ${flag.defaultValue}; existing value preserved)`);
  }

  console.log(`Seeded ${FLAGS.length} tts engine-flag Global Settings`);
};
