/**
 * ConsentGrant seed (TASK-712, consent-abac Phase 6).
 *
 * Seeds EXTERNAL_TOOL_LOOKUP / STYLE_LEARNING / QUALITY_REVIEW grants for the
 * demo patients in `09-consultation.ts`, so a freshly-seeded environment can
 * actually exercise the Phase-4 harness gates (`call_mcp_tool` asserts
 * EXTERNAL_TOOL_LOOKUP; a future STYLE_LEARNING/QUALITY_REVIEW consumer would
 * find a grant to evaluate against) without every demo tool call denying.
 *
 * AI_DOCUMENTATION / HISTORY_RETRIEVAL are ALSO seeded here now — see
 * `seedLegacyImportedGrants` at the bottom of this file.
 *
 * They used to be left to the legacy-grant backfill inside migration
 * `20260816030000_task_712_consent_grant` (Q2 option (a)). That was wrong for
 * local and test databases: rule 02 says the dev DB and `hope_test` are
 * `db push`-managed and carry NO `_prisma_migrations` ledger, so migrations
 * NEVER execute against them — only seeds do. The practical consequence, once
 * TASK-712 turned consent enforcement ON by default, was that a freshly-seeded
 * environment denied the core documentation flow outright:
 *   POST /consultations/:id/prime -> 403
 *   `Consent denied for purpose "AI_DOCUMENTATION" (no_grant)`
 * for EVERY seeded patient. The migration still exists for deployed databases
 * that DO replay migrations; this seed covers the ones that never will.
 *
 * CREATE-ONLY / idempotent: an existing ACTIVE grant (revokedAt IS NULL) for
 * the same (tenantId, externalPatientId, purpose) is left untouched — the
 * DB's partial unique index (`ConsentGrant_tenant_patient_purpose_active_key`)
 * isn't expressible as a Prisma `@@unique`, so this checks first rather than
 * using a typed `upsert` (same posture as `seedTenantTtsConfig`).
 */
import type { CorePrismaClient } from '../../../client';
import { ConsentGrantMethod, ConsentPurpose } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS, SEED_USER_IDS, SEED_CONSENT_GRANT_IDS } from './00-constants';
import { PATIENT_IDS } from './09-consultation';

interface ConsentGrantSeed {
  id: string;
  tenantId: string;
  externalPatientId: string;
  purpose: ConsentPurpose;
  grantedBy: string;
}

const GRANTED_AT = new Date('2026-01-01T00:00:00.000Z');

const PURPOSE_ID_SUFFIX: Record<'TOOL_LOOKUP' | 'STYLE_LEARNING' | 'QUALITY_REVIEW', ConsentPurpose> = {
  TOOL_LOOKUP: ConsentPurpose.EXTERNAL_TOOL_LOOKUP,
  STYLE_LEARNING: ConsentPurpose.STYLE_LEARNING,
  QUALITY_REVIEW: ConsentPurpose.QUALITY_REVIEW,
};

function buildGrants(): ConsentGrantSeed[] {
  const grants: ConsentGrantSeed[] = [];

  // Explicit, one row per (patient, purpose) — avoids a dynamic-key lookup
  // into SEED_CONSENT_GRANT_IDS (keeps every id traceable by search).
  const rows: Array<[string, keyof typeof SEED_CONSENT_GRANT_IDS, keyof typeof SEED_CONSENT_GRANT_IDS, keyof typeof SEED_CONSENT_GRANT_IDS]> = [
    [PATIENT_IDS.PAT_001, 'PAT_001_TOOL_LOOKUP', 'PAT_001_STYLE_LEARNING', 'PAT_001_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_002, 'PAT_002_TOOL_LOOKUP', 'PAT_002_STYLE_LEARNING', 'PAT_002_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_003, 'PAT_003_TOOL_LOOKUP', 'PAT_003_STYLE_LEARNING', 'PAT_003_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_004, 'PAT_004_TOOL_LOOKUP', 'PAT_004_STYLE_LEARNING', 'PAT_004_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_005, 'PAT_005_TOOL_LOOKUP', 'PAT_005_STYLE_LEARNING', 'PAT_005_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_006, 'PAT_006_TOOL_LOOKUP', 'PAT_006_STYLE_LEARNING', 'PAT_006_QUALITY_REVIEW'],
    [PATIENT_IDS.PAT_007, 'PAT_007_TOOL_LOOKUP', 'PAT_007_STYLE_LEARNING', 'PAT_007_QUALITY_REVIEW'],
  ];

  for (const [patientId, toolKey, styleKey, qualityKey] of rows) {
    grants.push(
      { id: SEED_CONSENT_GRANT_IDS[toolKey], tenantId: SEED_TENANT_ID, externalPatientId: patientId, purpose: PURPOSE_ID_SUFFIX.TOOL_LOOKUP, grantedBy: SEED_USER_IDS.DOCTOR },
      { id: SEED_CONSENT_GRANT_IDS[styleKey], tenantId: SEED_TENANT_ID, externalPatientId: patientId, purpose: PURPOSE_ID_SUFFIX.STYLE_LEARNING, grantedBy: SEED_USER_IDS.DOCTOR },
      { id: SEED_CONSENT_GRANT_IDS[qualityKey], tenantId: SEED_TENANT_ID, externalPatientId: patientId, purpose: PURPOSE_ID_SUFFIX.QUALITY_REVIEW, grantedBy: SEED_USER_IDS.DOCTOR },
    );
  }

  // ArcaAI customer-tenant demo patient (09-consultation.ts CUSTOMER_TENANT_CONSULTATIONS).
  const arcaaiPatientId = 'PAT-20260221-101';
  grants.push(
    {
      id: SEED_CONSENT_GRANT_IDS.ARCAAI_PAT_101_TOOL_LOOKUP,
      tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
      externalPatientId: arcaaiPatientId,
      purpose: PURPOSE_ID_SUFFIX.TOOL_LOOKUP,
      grantedBy: SEED_USER_IDS.ARCAAI_DOCTOR,
    },
    {
      id: SEED_CONSENT_GRANT_IDS.ARCAAI_PAT_101_STYLE_LEARNING,
      tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
      externalPatientId: arcaaiPatientId,
      purpose: PURPOSE_ID_SUFFIX.STYLE_LEARNING,
      grantedBy: SEED_USER_IDS.ARCAAI_DOCTOR,
    },
    {
      id: SEED_CONSENT_GRANT_IDS.ARCAAI_PAT_101_QUALITY_REVIEW,
      tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
      externalPatientId: arcaaiPatientId,
      purpose: PURPOSE_ID_SUFFIX.QUALITY_REVIEW,
      grantedBy: SEED_USER_IDS.ARCAAI_DOCTOR,
    },
  );

  return grants;
}

/**
 * Mirror of the TASK-712 migration backfill, for databases that never replay
 * migrations. One dated `IMPORTED` grant per (tenant, patient, purpose) for the
 * two purposes the explicit demo rows above do not cover, derived from the
 * Consultation table exactly as the migration's SELECT does — including the
 * TRIM, which matches `normalizeExternalPatientId` (Q3: trim only, exact case),
 * so the key matches what `assertConsent` looks up.
 */
const LEGACY_IMPORTED_PURPOSES = [ConsentPurpose.AI_DOCUMENTATION, ConsentPurpose.HISTORY_RETRIEVAL] as const;

const seedLegacyImportedGrants = async (client: CorePrismaClient): Promise<{ created: number; skipped: number }> => {
  const consultations = await client.consultation.findMany({ select: { tenantId: true, patientId: true } });
  const pairs = new Map<string, { tenantId: string; patientId: string }>();
  for (const c of consultations) {
    const patientId = (c.patientId ?? '').trim();
    if (!patientId) continue; // blank is never a real identifier — the migration skips these too
    pairs.set(`${c.tenantId}::${patientId}`, { tenantId: c.tenantId, patientId });
  }

  let created = 0;
  let skipped = 0;
  for (const { tenantId, patientId } of pairs.values()) {
    for (const purpose of LEGACY_IMPORTED_PURPOSES) {
      const existing = await client.consentGrant.findFirst({
        where: { tenantId, externalPatientId: patientId, purpose, revokedAt: null, resourceStatus: { not: 'DELETED' } },
      });
      if (existing) {
        skipped += 1;
        continue;
      }
      await client.consentGrant.create({
        data: {
          tenantId,
          externalPatientId: patientId,
          purpose,
          grantedAt: GRANTED_AT,
          grantedBy: SEED_USER_IDS.SYSTEM,
          grantMethod: ConsentGrantMethod.IMPORTED,
          evidenceRef: 'task-712-legacy-backfill',
          createdBy: SEED_USER_IDS.SYSTEM,
        },
      });
      created += 1;
    }
  }
  return { created, skipped };
};

export const seedConsentGrant = async (client: CorePrismaClient): Promise<void> => {
  console.log('Seeding demo ConsentGrant rows (EXTERNAL_TOOL_LOOKUP / STYLE_LEARNING / QUALITY_REVIEW)...');
  try {
    let created = 0;
    let skipped = 0;

    for (const grant of buildGrants()) {
      const existing = await client.consentGrant.findFirst({
        where: {
          tenantId: grant.tenantId,
          externalPatientId: grant.externalPatientId,
          purpose: grant.purpose,
          revokedAt: null,
          resourceStatus: { not: 'DELETED' },
        },
      });

      if (existing) {
        skipped += 1;
        continue;
      }

      await client.consentGrant.create({
        data: {
          id: grant.id,
          tenantId: grant.tenantId,
          externalPatientId: grant.externalPatientId,
          purpose: grant.purpose,
          grantedAt: GRANTED_AT,
          grantedBy: grant.grantedBy,
          grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
          createdBy: grant.grantedBy,
        },
      });
      created += 1;
    }

    const legacy = await seedLegacyImportedGrants(client);
    console.log(
      `Seeded ${created} ConsentGrant row(s), ${skipped} already present (left untouched); ` +
        `legacy IMPORTED (AI_DOCUMENTATION/HISTORY_RETRIEVAL): ${legacy.created} created, ${legacy.skipped} already present`,
    );
  } catch (error) {
    console.error('Error seeding ConsentGrant demo data:', error);
    throw error;
  }
};
