import { describe, it, expect } from 'vitest';
import { SEED_CUSTOMER_TENANT_IDS, SEED_GLOBAL_SETTING_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID } from '../prisma/db_main/seed/00-constants';
import { ALL_SETTINGS, PLATFORM_SETTINGS, RETIRED_GLOBAL_SETTING_KEYS } from '../prisma/db_main/seed/11-global-setting';
import { DEFAULT_STT_SETTINGS } from '../prisma/db_main/seed/06-stt';
import { DNA_REGEN_SETTINGS } from '../prisma/db_main/seed/08-dna-writing-style';
import { GATES as CONSULTATION_GATE_SETTINGS } from '../prisma/db_main/seed/11c-consultation-gate-settings';
import {
  KNOBS as PLATFORM_KNOB_SETTINGS,
  CONDITIONAL_KNOBS as PLATFORM_CONDITIONAL_KNOB_SETTINGS,
} from '../prisma/db_main/seed/11a-platform-knob-settings';
import { RATE_LIMIT_SETTINGS } from '../prisma/db_main/seed/12-rate-limit-settings';
import { ENTITLEMENTS_GLOBAL_SETTING_IDENTITIES } from '../prisma/db_main/seed/15-entitlements';
import { USER_GLOBAL_SETTING_IDENTITIES } from '../prisma/db_main/seed/91-user';

const UUID_REGEX = /^85000000-/;

const SETTING_PREFIXES = ['ARCAAI', 'GLOBAL'] as const;

const GENERAL_SUFFIXES = ['MAX_CONCURRENT_SESSIONS', 'DEFAULT_LANGUAGE', 'SESSION_TIMEOUT'] as const;

const CORE_SUFFIXES = [
  // TASK-932 R-8 — FF_TRANSCRIPTION / FF_DNA_STYLE / FF_CROSS_CHAIN / FF_NER /
  // FF_CODE_SWITCHING were here. Their rows had NO runtime consumer (the SDK's
  // own key constant does not even match the seeded `enable-transcription`), so
  // they are no longer emitted and `RETIRED_GLOBAL_SETTING_KEYS` sweeps the
  // copies an already-provisioned database holds. Their ids stay reserved in
  // `00-constants.ts`, like every other retired block.
  //
  // FF_CONSULTATION_SHARING moved to `RETIRED_CORE_SUFFIXES` below by TASK-932
  // wave 4 OD-1 — the per-tenant clone is retired (the registry cascade
  // supplies the same default on absence), so it is no longer emitted either.
  'STT_MODEL',
  'STT_VAD',
  // TEXT Azure deployment-name (032), seeded for every tenant.
  // TEXT_PROVIDER/TEXT_MODEL (030/031), the guardrail namespace
  // (033/034/035) and UX_TEXT_PROVIDER_MODELS (043) were RETIRED (superseded
  // by HarnessPolicy + AiRoutingPolicy + the AiModel registry); their ids stay
  // reserved but are no longer declared or emitted.
  'TEXT_AZURE_DEPLOYMENT',
  'UX_LOCAL_ASR_MODELS',
  'UX_LOCAL_VAD_MODELS',
  'UX_LOCAL_NOISE_SUPPRESSION_MODELS',
  // Guardrail provider/model catalog (044).
  'UX_GUARDRAIL_PROVIDER_MODELS',
  'LOCKED_CONFIG_PATHS',
  // Per-tenant admin-console menu order (`arcaai-admin`/`menuOrder`),
  // suffix 051 alongside locked-config-paths (050). Seeded for every tenant.
  'ADMIN_MENU_ORDER',
] as const;

// Every tenant (including ArcaAI) now carries the `general`
// namespace block (max-concurrent-sessions, default-language, session-timeout) so
// both tenants are consistent and no admin "General" tab is left empty.
const PREFIXES_WITH_GENERAL = new Set(['ARCAAI', 'GLOBAL']);

// Platform-wide (NOT per-tenant) settings: DB-backed gateway
// rate-limit config. These live on the platform tenant only and therefore
// fall outside the per-prefix model above, so they're counted separately.
// ENTITLEMENTS_ENABLED joins the same platform-tenant-only block:
// the entitlements enforcement kill-switch (seeded OFF in 15-entitlements.ts).
const PLATFORM_WIDE_KEYS = [
  'RATE_LIMIT_ENABLED',
  'RATE_LIMIT_TIER_DEFAULT_LIMIT',
  'RATE_LIMIT_TIER_DEFAULT_TTL',
  'RATE_LIMIT_TIER_STRICT_LIMIT',
  'RATE_LIMIT_TIER_STRICT_TTL',
  'RATE_LIMIT_TIER_HEAVY_LIMIT',
  'RATE_LIMIT_TIER_HEAVY_TTL',
  'RATE_LIMIT_TIER_RELAXED_LIMIT',
  'RATE_LIMIT_TIER_RELAXED_TTL',
  // TASK-993: level two of the two-level bucketing model (OD-2) and the
  // breach posture (D-2). Same platform-tenant-only block as the tiers above.
  'RATE_LIMIT_PRINCIPAL_ENABLED',
  'RATE_LIMIT_PRINCIPAL_LIMIT',
  'RATE_LIMIT_PRINCIPAL_TTL',
  'RATE_LIMIT_LOCKOUT_ENABLED',
  'ENTITLEMENTS_ENABLED',
  // The metering reconcile-sweep kill-switch joins the
  // same platform-tenant-only block, seeded alongside ENTITLEMENTS_ENABLED.
  'METERING_RECONCILE_ENABLED',
] as const;

// System-tenant (SYSTEM_TENANT_ID) platform rows: not per-tenant and not part of
// the rate-limit block, so they fall outside the per-prefix model and are counted
// separately.
//   Locked capability flag for local raw-stream dual-capture.
//   Locked controls for the nightly SYSTEM-template resync sweep.
const SYSTEM_WIDE_KEYS = [
  'SYSTEM_FF_LOCAL_RAW_CAPTURE',
  'SYSTEM_PIPELINE_TEMPLATE_RESYNC_ENABLED',
  'SYSTEM_PIPELINE_TEMPLATE_RESYNC_CRON',
  // The agent golden-library resync sweep's two controls used to sit here.
  // They went with `DepartmentAgent` — the sweep reconciled a
  // per-department agent catalog that no longer exists. `TOTAL_IDS` is derived
  // from these arrays, so the count assertion follows on its own.
] as const;

/**
 * Suffixes whose ID CONSTANTS are still declared in `00-constants.ts` but whose
 * rows are no longer emitted.
 *
 * Retired ids are kept reserved rather than deleted, so a future block cannot
 * silently reuse a UUID an already-provisioned database still holds a row
 * under. `TOTAL_IDS` therefore counts them, and `suffixesFor` does not — the two
 * questions ("which ids exist" and "which rows are seeded") stopped having the
 * same answer when TASK-932 R-8 removed the five advisory feature flags.
 *
 * FF_CONSULTATION_SHARING joined this list in TASK-932 wave 4 (OD-1): its
 * per-tenant clone is retired (the registry cascade's descriptor default now
 * supplies the same effective value on absence), so the feature-flags
 * namespace emits ZERO per-tenant rows.
 */
const RETIRED_CORE_SUFFIXES = [
  'FF_TRANSCRIPTION',
  'FF_DNA_STYLE',
  'FF_CROSS_CHAIN',
  'FF_NER',
  'FF_CODE_SWITCHING',
  'FF_CONSULTATION_SHARING',
] as const;

function suffixesFor(prefix: string) {
  return PREFIXES_WITH_GENERAL.has(prefix) ? [...GENERAL_SUFFIXES, ...CORE_SUFFIXES] : [...CORE_SUFFIXES];
}

function settingIdKey(prefix: (typeof SETTING_PREFIXES)[number], suffix: string): keyof typeof SEED_GLOBAL_SETTING_IDS {
  // GLOBAL + ADMIN_MENU_ORDER concatenates to the retired GLOBAL_ADMIN role token.
  if (prefix === 'GLOBAL' && suffix === 'ADMIN_MENU_ORDER') {
    return 'GLOBAL_TENANT_ADMIN_MENU_ORDER';
  }
  return `${prefix}_${suffix}` as keyof typeof SEED_GLOBAL_SETTING_IDS;
}

const TOTAL_IDS =
  SETTING_PREFIXES.reduce((sum, p) => sum + suffixesFor(p).length + RETIRED_CORE_SUFFIXES.length, 0) +
  PLATFORM_WIDE_KEYS.length +
  SYSTEM_WIDE_KEYS.length;

describe('Global Settings Seed Data (11-global-setting)', () => {
  describe('every tenant has all expected setting IDs', () => {
    for (const prefix of SETTING_PREFIXES) {
      const expected = suffixesFor(prefix);
      describe(prefix, () => {
        for (const suffix of expected) {
          const key = settingIdKey(prefix, suffix);
          it(`should define ${key}`, () => {
            expect(SEED_GLOBAL_SETTING_IDS[key]).toBeDefined();
            expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(UUID_REGEX);
          });
        }

        it(`should have exactly ${expected.length} settings`, () => {
          const count = expected.filter((suffix) => {
            const key = settingIdKey(prefix, suffix);
            return SEED_GLOBAL_SETTING_IDS[key] !== undefined;
          }).length;
          expect(count).toBe(expected.length);
        });
      });
    }
  });

  describe('UUID segment convention per tenant', () => {
    const SEGMENT_MAP: Record<string, string> = {
      GLOBAL: '0000',
      ARCAAI: '0001',
    };

    for (const [prefix, segment] of Object.entries(SEGMENT_MAP)) {
      it(`${prefix} settings should use segment ${segment}`, () => {
        const segmentRegex = new RegExp(`^85000000-0000-0000-${segment}-`);
        for (const suffix of suffixesFor(prefix)) {
          const key = settingIdKey(prefix as (typeof SETTING_PREFIXES)[number], suffix);
          expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(segmentRegex);
        }
      });
    }
  });

  describe('UX constant IDs use 04x range across all tenants', () => {
    const UX_SUFFIXES = ['UX_LOCAL_ASR_MODELS', 'UX_LOCAL_VAD_MODELS', 'UX_LOCAL_NOISE_SUPPRESSION_MODELS'] as const;

    for (const prefix of SETTING_PREFIXES) {
      it(`${prefix} UX constants should use 04x range`, () => {
        const uxRangeRegex = /00000000004\d$/;
        for (const suffix of UX_SUFFIXES) {
          const key = settingIdKey(prefix, suffix);
          expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(uxRangeRegex);
        }
      });
    }
  });

  describe('no duplicate IDs across tenants', () => {
    it('should have unique IDs for every setting', () => {
      const allIds = Object.values(SEED_GLOBAL_SETTING_IDS);
      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });

    it(`should have exactly ${TOTAL_IDS} total IDs`, () => {
      const allIds = Object.values(SEED_GLOBAL_SETTING_IDS);
      expect(allIds.length).toBe(TOTAL_IDS);
    });
  });

  describe('platform-wide settings (rate-limit, entitlements)', () => {
    for (const key of PLATFORM_WIDE_KEYS) {
      it(`should define ${key}`, () => {
        const id = SEED_GLOBAL_SETTING_IDS[key as keyof typeof SEED_GLOBAL_SETTING_IDS];
        expect(id).toBeDefined();
        expect(id).toMatch(UUID_REGEX);
      });
    }
  });

  describe('system-wide settings (local raw-capture)', () => {
    for (const key of SYSTEM_WIDE_KEYS) {
      it(`should define ${key} on the system tenant`, () => {
        const id = SEED_GLOBAL_SETTING_IDS[key as keyof typeof SEED_GLOBAL_SETTING_IDS];
        expect(id).toBeDefined();
        expect(id).toMatch(/^00000000-/);
      });
    }
  });

  describe('Tenant ID constants', () => {
    it('should define the global tenant ID', () => {
      expect(SEED_TENANT_ID).toBe('50000000-0000-0000-0000-000000000000');
    });

    it('should define the ArcaAI customer tenant ID', () => {
      expect(SEED_CUSTOMER_TENANT_IDS.ARCAAI).toBeDefined();
    });
  });

  // Assert the FACTORY actually EMITS the rows, not just
  // that the IDs exist. The previous code allocated `*_FF_TRANSCRIPTION` and the
  // GENERAL ids but `tenantSettings()` emitted neither (dead config), leaving the
  // admin "General" tab empty for every tenant. These assertions pin the emitted
  // per-tenant rows so the IDs and the seed can never silently drift apart again.
  describe('tenantSettings factory emits a consistent block for every tenant', () => {
    const TENANT_ID_BY_PREFIX: Record<string, string> = {
      GLOBAL: SEED_TENANT_ID,
      ARCAAI: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    };

    const settingsForTenant = (tenantId: string) => ALL_SETTINGS.filter((s) => s.tenantId === tenantId);

    for (const prefix of SETTING_PREFIXES) {
      const tenantId = TENANT_ID_BY_PREFIX[prefix];
      describe(prefix, () => {
        it('emits the general namespace block (3 settings)', () => {
          const generalKeys = settingsForTenant(tenantId)
            .filter((s) => s.namespace === 'general')
            .map((s) => s.key)
            .sort();
          expect(generalKeys).toEqual(['default-language', 'max-concurrent-sessions', 'session-timeout']);
        });

        // TASK-932 R-8 removed five advisory `feature-flags` rows with no
        // runtime consumer, leaving exactly one:
        // `enable-consultation-sharing` (actually read by
        // `ConsultationController.isSharingEnabled`). Wave 4 OD-1 then
        // retired ITS per-tenant clone too — the registry cascade's
        // `maxScope: 'tenant'` descriptor default now supplies the same
        // effective value on absence — so the namespace emits NO rows at
        // all. Asserted ABSENT rather than merely not asserted present: a
        // control surface that changes nothing is worse than none, and this
        // is what stops one being re-added by copy-paste.
        it('emits NO feature-flags namespace settings (retired by TASK-932 R-8 + OD-1)', () => {
          const flags = settingsForTenant(tenantId)
            .filter((s) => s.namespace === 'feature-flags')
            .map((s) => s.key);
          expect(flags).toEqual([]);
        });

        // The guardrail namespace is RETIRED (superseded
        // by AiRoutingPolicy + the AiModel registry); nothing is emitted and
        // `retireSupersededGlobalSettings` sweeps existing rows to DELETED.
        it('emits NO guardrail namespace settings (retired by)', () => {
          const guardrail = settingsForTenant(tenantId).filter((s) => s.namespace === 'guardrail');
          expect(guardrail).toEqual([]);
        });

        // TEXT Azure deployment-name parity (non-secret, unlocked).
        it('emits the text-azure-deployment setting (non-secret, unlocked)', () => {
          const azure = settingsForTenant(tenantId).find((s) => s.namespace === 'text' && s.key === 'text-azure-deployment');
          expect(azure).toBeDefined();
          expect(azure?.value).toBe('');
          expect(azure?.locked).toBeFalsy();
        });

        it('emits exactly one row per declared setting ID (no dead config)', () => {
          expect(settingsForTenant(tenantId).length).toBe(suffixesFor(prefix).length);
        });
      });
    }

    it('emits the same number of settings for every tenant', () => {
      const counts = SETTING_PREFIXES.map((p) => settingsForTenant(TENANT_ID_BY_PREFIX[p]).length);
      expect(new Set(counts).size).toBe(1);
    });
  });
});

// =============================================================================
// TASK-932 S1-1 — cross-seed (tenantId, key) uniqueness.
//
// `GlobalSetting` only ever enforced `(tenantId, name, key)` uniqueness, so
// two rows could share the SAME (tenantId, key) as long as their `name`
// differed — exactly what happened historically to `rate-limit.enabled`
// (see `settings-registry-write.service.ts`'s `pickBackingRow` doc: a
// duplicate SYSTEM row made `AppSettingsService` refuse to build its
// boot-time cache at all). A new DB-level unique index
// (`GlobalSetting_tenantId_key_unique`, this ticket's migration) now makes a
// collision impossible at the database layer; THIS test is the static,
// no-database pin that every seed FILE agrees with that constraint before a
// migration ever runs.
//
// `identityOf` isolates the (tenantId, key) pair regardless of a seed
// array's other fields, and `findDuplicateKeys` is unit-pinned below with a
// fabricated collision before it is trusted against the real seed data — the
// same discipline as any other pure function.
// =============================================================================

interface GlobalSettingIdentity {
  tenantId: string;
  key: string;
}

/** Every group of size > 1 is a real (tenantId, key) collision; returns one entry per colliding pair, annotated with how many rows share it. */
function findDuplicateKeys(rows: readonly GlobalSettingIdentity[]): Array<{ tenantId: string; key: string; count: number }> {
  const counts = new Map<string, { tenantId: string; key: string; count: number }>();
  for (const row of rows) {
    const id = `${row.tenantId}::${row.key}`;
    const existing = counts.get(id);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(id, { tenantId: row.tenantId, key: row.key, count: 1 });
    }
  }
  return [...counts.values()].filter((entry) => entry.count > 1);
}

describe('(tenantId, key) uniqueness across every seed source', () => {
  describe('findDuplicateKeys (the pin itself)', () => {
    it('flags a fabricated (tenantId, key) collision', () => {
      const duplicates = findDuplicateKeys([
        { tenantId: SYSTEM_TENANT_ID, key: 'rate-limit.enabled' },
        { tenantId: SYSTEM_TENANT_ID, key: 'rate-limit.enabled' },
      ]);
      expect(duplicates).toEqual([{ tenantId: SYSTEM_TENANT_ID, key: 'rate-limit.enabled', count: 2 }]);
    });

    it('does not flag the same key under two different tenants', () => {
      const duplicates = findDuplicateKeys([
        { tenantId: SEED_TENANT_ID, key: 'session-timeout' },
        { tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI, key: 'session-timeout' },
      ]);
      expect(duplicates).toEqual([]);
    });
  });

  describe('the real seed data', () => {
    // Every array/loop across the repo that writes a `GlobalSetting` row,
    // flattened to its (tenantId, key) identity. A file whose settings all
    // land on one fixed tenant (the platform-knob/rate-limit/consultation-gate
    // registries) is zipped with that constant here rather than exported with
    // a redundant `tenantId` field on every row.
    const ALL_SEEDED_IDENTITIES: GlobalSettingIdentity[] = [
      ...ALL_SETTINGS.map((s) => ({ tenantId: s.tenantId, key: s.key })),
      ...PLATFORM_SETTINGS.map((s) => ({ tenantId: s.tenantId, key: s.key })),
      ...DEFAULT_STT_SETTINGS.map((s) => ({ tenantId: s.tenantId, key: s.key })),
      ...DNA_REGEN_SETTINGS.map((s) => ({ tenantId: s.tenantId, key: s.key })),
      ...CONSULTATION_GATE_SETTINGS.map((s) => ({ tenantId: SYSTEM_TENANT_ID, key: s.key })),
      ...PLATFORM_KNOB_SETTINGS.map((s) => ({ tenantId: SYSTEM_TENANT_ID, key: s.key })),
      ...PLATFORM_CONDITIONAL_KNOB_SETTINGS.map((s) => ({ tenantId: SYSTEM_TENANT_ID, key: s.key })),
      ...RATE_LIMIT_SETTINGS.map((s) => ({ tenantId: SYSTEM_TENANT_ID, key: s.key })),
      ...ENTITLEMENTS_GLOBAL_SETTING_IDENTITIES,
      ...USER_GLOBAL_SETTING_IDENTITIES,
    ];

    it('no two seeded rows share a (tenantId, key) pair', () => {
      expect(findDuplicateKeys(ALL_SEEDED_IDENTITIES)).toEqual([]);
    });

    it('is actually checking something (the combined seed set is non-trivial)', () => {
      // A guard against the check silently checking nothing (e.g. every
      // import above resolving to `undefined` and `.map` throwing would be
      // caught by the test runner anyway, but an accidental empty array from
      // a bad import would not be).
      expect(ALL_SEEDED_IDENTITIES.length).toBeGreaterThan(50);
    });
  });
});

// =============================================================================
// TASK-932 S1-4, owner decision OD-8 — legacy S3_PUBLIC_BUCKET /
// S3_PRIVATE_BUCKET retirement.
//
// `06-stt.ts`'s `DEFAULT_STT_SETTINGS` no longer seeds these two keys into a
// fresh database; this pins that an already-provisioned database still gets
// them swept to DELETED via `RETIRED_GLOBAL_SETTING_KEYS`
// (`retireSupersededGlobalSettings`, run on every `db:seed`).
// =============================================================================
describe('S3_PUBLIC_BUCKET / S3_PRIVATE_BUCKET retirement (TASK-932 OD-8)', () => {
  it('both legacy platform bucket keys are in the retired-keys sweep', () => {
    const retired = RETIRED_GLOBAL_SETTING_KEYS.filter((k) => k.namespace === 'platform');
    expect(retired).toEqual(
      expect.arrayContaining([
        { namespace: 'platform', key: 'S3_PRIVATE_BUCKET' },
        { namespace: 'platform', key: 'S3_PUBLIC_BUCKET' },
      ]),
    );
  });

  it('neither key is seeded by DEFAULT_STT_SETTINGS any more', () => {
    const keys = DEFAULT_STT_SETTINGS.map((s) => s.key);
    expect(keys).not.toContain('S3_PUBLIC_BUCKET');
    expect(keys).not.toContain('S3_PRIVATE_BUCKET');
  });
});
