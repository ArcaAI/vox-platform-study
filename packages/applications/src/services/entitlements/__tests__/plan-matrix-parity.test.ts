/*
 * (test 41) — the plan matrix has TWO copies and, until this
 * file, NO drift guard at all.
 *
 *   Copy A  packages/database/src/prisma/db_main/seed/15-entitlements.ts
 *           → `PLAN_ENTITLEMENTS`, what a fresh DB actually gets.
 *   Copy B  packages/applications/src/services/entitlements/entitlements.constants.ts
 *           → `PLAN_ENTITLEMENT_DEFAULTS`, what the resolver falls back to when
 *             a plan's DB row is missing.
 *
 * Both files SAY the sync is manual (`15-entitlements.ts` header,
 * `00-constants.ts:706`), because the database package must not depend on
 * `@arcaai/applications`. Nothing checked it. A mismatch is silent by
 * construction — the seed writes the DB and the constant is only the fallback,
 * so the two diverge only for a tenant whose plan row is missing, which is
 * exactly the tenant nobody is looking at.
 *
 * That was tolerable while the matrix held quotas. It is not tolerable now that
 * it holds `featurePlatformDefaultCredential`, where a `true` on one side and a
 * `false` on the other silently grants or denies PLATFORM SPEND.
 *
 * IMPORT DIRECTION. `@arcaai/applications` → `@arcaai/database` is the allowed
 * direction (the ban is the reverse), but the seed module is not on the
 * `@arcaai/database` public barrel and the package's `exports` map has no
 * matching subpath, so a package-name import cannot reach it. This file uses a
 * relative source import instead — the same thing the database package's own
 * seed tests do, one directory further out. `PLAN_ENTITLEMENTS` was exported
 * for exactly this purpose (it was module-private before).
 */
import { describe, expect, it } from 'vitest';
import { TenantPlan } from '@arcaai/domains';

// eslint-disable-next-line no-restricted-imports -- deep source import: the seed matrix is not on the @arcaai/database barrel (see header).
import { PLAN_ENTITLEMENTS } from '../../../../../database/src/prisma/db_main/seed/15-entitlements';
import { PLAN_ENTITLEMENT_DEFAULTS, PlanEntitlementValues } from '../entitlements.constants';

/**
 * Every field of `PlanEntitlementValues`. Spelled out rather than derived from
 * `Object.keys` of one copy: a field added to ONE side must fail this test, and
 * a key-derived list would happily compare only the fields the source copy
 * happens to have.
 */
const MATRIX_FIELDS = [
  'maxUsers',
  'maxDepartments',
  'maxPromptTemplates',
  'maxAsrPipelines',
  'maxApiKeys',
  'storageQuotaBytes',
  'maxConcurrentSessions',
  'monthlyConsultations',
  'monthlyTranscriptionMinutes',
  'monthlySummaries',
  'monthlySttSessionSeconds',
  'monthlyLlmTokens',
  'monthlyTtsCharacters',
  'monthlyNlpTextUnits',
  'monthlyEmbeddingTokens',
  'featureDnaReports',
  'featureVoiceEnrollment',
  'featureMonitoringAccess',
  'featurePlatformDefaultCredential',
  'modelTier',
  'rateLimitTier',
] as const satisfies readonly (keyof PlanEntitlementValues)[];

/**
 * The seed types the byte/token columns as `bigint` (Prisma's wire type for
 * `BigInt?`) while the constants use `number` (the resolver normalises with the
 * same `Number()` cast). Compare on the normalised value so the guard fires on
 * a real disagreement, never on the representation.
 */
const normalize = (value: unknown): unknown => (typeof value === 'bigint' ? Number(value) : value);

describe('plan matrix parity — seed 15-entitlements.ts vs entitlements.constants.ts', () => {
  it('the two copies describe the same four plans', () => {
    const seeded = PLAN_ENTITLEMENTS.map((row) => row.plan).sort();
    const constants = Object.keys(PLAN_ENTITLEMENT_DEFAULTS).sort();
    expect(seeded).toEqual(constants);
    expect(seeded).toEqual(['ENTERPRISE', 'PRO', 'STARTER', 'TRIAL']);
  });

  for (const plan of [TenantPlan.STARTER, TenantPlan.TRIAL, TenantPlan.PRO, TenantPlan.ENTERPRISE]) {
    it(`${plan} agrees field-for-field`, () => {
      const seedRow = PLAN_ENTITLEMENTS.find((row) => row.plan === plan);
      expect(seedRow, `seed is missing a ${plan} row`).toBeDefined();
      const constantRow = PLAN_ENTITLEMENT_DEFAULTS[plan];

      for (const field of MATRIX_FIELDS) {
        const fromSeed = normalize((seedRow as unknown as Record<string, unknown>)[field]);
        const fromConstant = normalize((constantRow as unknown as Record<string, unknown>)[field]);
        expect(fromSeed, `${plan}.${field}: seed ${String(fromSeed)} vs constant ${String(fromConstant)}`).toBe(fromConstant);
      }
    });
  }

  it('neither copy carries a matrix field the other lacks', () => {
    const ignoredSeedOnlyKeys = new Set(['id', 'plan']);
    const fields = new Set<string>(MATRIX_FIELDS);

    for (const row of PLAN_ENTITLEMENTS) {
      const extra = Object.keys(row).filter((key) => !fields.has(key) && !ignoredSeedOnlyKeys.has(key));
      expect(extra, `seed row ${row.plan} carries unchecked field(s) — add them to MATRIX_FIELDS and to entitlements.constants.ts`).toEqual([]);
    }

    for (const [plan, row] of Object.entries(PLAN_ENTITLEMENT_DEFAULTS)) {
      const extra = Object.keys(row).filter((key) => !fields.has(key));
      expect(extra, `constant row ${plan} carries unchecked field(s) — add them to MATRIX_FIELDS and to the seed`).toEqual([]);
    }
  });

  // The field this guard was written for. Explicit so the reason the file
  // exists survives a future refactor of the loop above.
  it('featurePlatformDefaultCredential is false in BOTH copies, for every plan (OD-7)', () => {
    for (const row of PLAN_ENTITLEMENTS) {
      expect(row.featurePlatformDefaultCredential, `seed ${row.plan}`).toBe(false);
    }
    for (const [plan, row] of Object.entries(PLAN_ENTITLEMENT_DEFAULTS)) {
      expect(row.featurePlatformDefaultCredential, `constant ${plan}`).toBe(false);
    }
  });
});
