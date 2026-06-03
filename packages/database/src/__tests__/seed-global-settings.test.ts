import { describe, it, expect } from 'vitest';
import {
  SEED_CUSTOMER_TENANT_IDS,
  SEED_GLOBAL_SETTING_IDS,
  SEED_TENANT_ID,
} from '../prisma/db_main/seed/00-constants';
import { ALL_SETTINGS } from '../prisma/db_main/seed/11-global-setting';

const UUID_REGEX = /^85000000-/;

const SETTING_PREFIXES = ['ARCAAI', 'FOURBITS', 'MUMBAI', 'GLOBAL'] as const;

const GENERAL_SUFFIXES = [
  'MAX_CONCURRENT_SESSIONS',
  'DEFAULT_LANGUAGE',
  'SESSION_TIMEOUT',
] as const;

const CORE_SUFFIXES = [
  'FF_TRANSCRIPTION',
  'FF_DNA_STYLE',
  'FF_CROSS_CHAIN',
  'FF_NER',
  'FF_CODE_SWITCHING',
  'FF_CONSULTATION_SHARING',
  'STT_MODEL',
  'STT_VAD',
  'SMR_PROVIDER',
  'SMR_MODEL',
  'UX_LOCAL_ASR_MODELS',
  'UX_LOCAL_VAD_MODELS',
  'UX_LOCAL_NOISE_SUPPRESSION_MODELS',
  'UX_SMR_PROVIDER_MODELS',
  'LOCKED_CONFIG_PATHS',
  // TASK-331 F4 — per-tenant admin-console menu order (`arcaai-admin`/`menuOrder`),
  // suffix 051 alongside locked-config-paths (050). Seeded for every tenant.
  'ADMIN_MENU_ORDER',
] as const;

// TASK-331 doc-08 F4 — every tenant (including ArcaAI) now carries the `general`
// namespace block (max-concurrent-sessions, default-language, session-timeout) so
// all four tenants are consistent and no admin "General" tab is left empty.
const PREFIXES_WITH_GENERAL = new Set(['ARCAAI', 'FOURBITS', 'MUMBAI', 'GLOBAL']);

// TASK-316 — platform-wide (NOT per-tenant) settings: DB-backed gateway
// rate-limit config. These live on the platform tenant only and therefore
// fall outside the per-prefix model above, so they're counted separately.
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
] as const;

function suffixesFor(prefix: string) {
  return PREFIXES_WITH_GENERAL.has(prefix)
    ? [...GENERAL_SUFFIXES, ...CORE_SUFFIXES]
    : [...CORE_SUFFIXES];
}

const TOTAL_IDS =
  SETTING_PREFIXES.reduce((sum, p) => sum + suffixesFor(p).length, 0) +
  PLATFORM_WIDE_KEYS.length;

describe('Global Settings Seed Data (11-global-setting)', () => {
  describe('every tenant has all expected setting IDs', () => {
    for (const prefix of SETTING_PREFIXES) {
      const expected = suffixesFor(prefix);
      describe(prefix, () => {
        for (const suffix of expected) {
          const key = `${prefix}_${suffix}` as keyof typeof SEED_GLOBAL_SETTING_IDS;
          it(`should define ${key}`, () => {
            expect(SEED_GLOBAL_SETTING_IDS[key]).toBeDefined();
            expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(UUID_REGEX);
          });
        }

        it(`should have exactly ${expected.length} settings`, () => {
          const count = expected.filter((suffix) => {
            const key = `${prefix}_${suffix}` as keyof typeof SEED_GLOBAL_SETTING_IDS;
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
      FOURBITS: '0002',
      MUMBAI: '0003',
    };

    for (const [prefix, segment] of Object.entries(SEGMENT_MAP)) {
      it(`${prefix} settings should use segment ${segment}`, () => {
        const segmentRegex = new RegExp(`^85000000-0000-0000-${segment}-`);
        for (const suffix of suffixesFor(prefix)) {
          const key = `${prefix}_${suffix}` as keyof typeof SEED_GLOBAL_SETTING_IDS;
          expect(SEED_GLOBAL_SETTING_IDS[key]).toMatch(segmentRegex);
        }
      });
    }
  });

  describe('UX constant IDs use 04x range across all tenants', () => {
    const UX_SUFFIXES = [
      'UX_LOCAL_ASR_MODELS',
      'UX_LOCAL_VAD_MODELS',
      'UX_LOCAL_NOISE_SUPPRESSION_MODELS',
    ] as const;

    for (const prefix of SETTING_PREFIXES) {
      it(`${prefix} UX constants should use 04x range`, () => {
        const uxRangeRegex = /00000000004\d$/;
        for (const suffix of UX_SUFFIXES) {
          const key = `${prefix}_${suffix}` as keyof typeof SEED_GLOBAL_SETTING_IDS;
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

  describe('platform-wide settings (TASK-316 rate-limit)', () => {
    for (const key of PLATFORM_WIDE_KEYS) {
      it(`should define ${key}`, () => {
        const id = SEED_GLOBAL_SETTING_IDS[key as keyof typeof SEED_GLOBAL_SETTING_IDS];
        expect(id).toBeDefined();
        expect(id).toMatch(UUID_REGEX);
      });
    }
  });

  describe('Tenant ID constants', () => {
    it('should define the global tenant ID', () => {
      expect(SEED_TENANT_ID).toBe('50000000-0000-0000-0000-000000000000');
    });

    it('should define all three customer tenant IDs', () => {
      expect(SEED_CUSTOMER_TENANT_IDS.ARCAAI).toBeDefined();
      expect(SEED_CUSTOMER_TENANT_IDS.FOURBITS).toBeDefined();
      expect(SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL).toBeDefined();
    });
  });

  // TASK-331 doc-08 F4 — assert the FACTORY actually EMITS the rows, not just
  // that the IDs exist. The previous code allocated `*_FF_TRANSCRIPTION` and the
  // GENERAL ids but `tenantSettings()` emitted neither (dead config), leaving the
  // admin "General" tab empty for every tenant. These assertions pin the emitted
  // per-tenant rows so the IDs and the seed can never silently drift apart again.
  describe('tenantSettings factory emits a consistent block for every tenant', () => {
    const TENANT_ID_BY_PREFIX: Record<string, string> = {
      GLOBAL: SEED_TENANT_ID,
      ARCAAI: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
      FOURBITS: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
      MUMBAI: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
    };

    const settingsForTenant = (tenantId: string) =>
      ALL_SETTINGS.filter((s) => s.tenantId === tenantId);

    for (const prefix of SETTING_PREFIXES) {
      const tenantId = TENANT_ID_BY_PREFIX[prefix];
      describe(prefix, () => {
        it('emits the general namespace block (3 settings)', () => {
          const generalKeys = settingsForTenant(tenantId)
            .filter((s) => s.namespace === 'general')
            .map((s) => s.key)
            .sort();
          expect(generalKeys).toEqual([
            'default-language',
            'max-concurrent-sessions',
            'session-timeout',
          ]);
        });

        it('emits the enable-transcription feature flag', () => {
          const flag = settingsForTenant(tenantId).find(
            (s) => s.namespace === 'feature-flags' && s.key === 'enable-transcription',
          );
          expect(flag).toBeDefined();
        });

        it('emits exactly one row per declared setting ID (no dead config)', () => {
          expect(settingsForTenant(tenantId).length).toBe(suffixesFor(prefix).length);
        });
      });
    }

    it('emits the same number of settings for every tenant', () => {
      const counts = SETTING_PREFIXES.map(
        (p) => settingsForTenant(TENANT_ID_BY_PREFIX[p]).length,
      );
      expect(new Set(counts).size).toBe(1);
    });
  });
});
