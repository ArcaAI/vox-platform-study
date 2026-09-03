import type { CorePrismaClient } from '../../../client';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * PipelinePolicy Seed (Realtime cascade)
 *
 * The realtime-pipeline toggle cascade (auto-summary / auto-NER / harness
 * routing) is resolved by `ConfigResolver`
 *   DOCTOR → DEPARTMENT → TENANT → SYSTEM-tenant default → code-default.
 *
 * Two TENANT-scope rows bootstrap that cascade:
 *
 *  1. SYSTEM-tenant GLOBAL DEFAULT (`SYSTEM_TENANT_ID`) — every tenant without an
 *     override falls through to this. `autoSummaryEnabled`/`autoNerEnabled = true`
 * (matching DEFAULT_PIPELINE_CONFIG) and, since,
 *     `harnessEnabled = true`: the legacy signable generator this toggle used to
 *     fall back to was deleted in that ticket (Phase 2 exit criterion — the
 *     R-2 boundary keeps the un-gated pre-summary/comprehensive-summary/sync-
 *     summary helper generators, which never read this toggle at all). Before
 * this defaulted to `false` (legacy platform behavior); see
 *     pre-production owner authorization to flip it ahead of a real
 *     multi-cohort migration (no real tenant traffic existed to cohort).
 *
 *  2. DEMO-tenant OVERRIDE (`SEED_TENANT_ID`, the Global customer tenant) — pins
 *     `harnessEnabled = true` (now redundant with the SYSTEM default, kept as an
 * explicit override for clarity/back-compat with earlier deployments
 *     whose SYSTEM row has not yet been migrated — see the data migration
 *     under `db_main/migrations/`). Other toggles stay NULL (inherit the
 *     SYSTEM default).
 *
 *  3. ArcaAI-tenant OVERRIDE (`SEED_CUSTOMER_TENANT_IDS.ARCAAI`) — same
 *     reasoning as the demo tenant. Other toggles stay NULL (inherit
 *     the SYSTEM default).
 *
 * The migration also bootstraps the SYSTEM default (a fixed-id INSERT … ON CONFLICT
 * DO NOTHING), so on a migrated database this step is a no-op for the SYSTEM row;
 * it still authoritatively creates the demo override, and creates the SYSTEM row
 * on a `db push` database that skipped migrations. It is idempotent (find-then-
 * create — NOT a blind upsert, because the (tenantId, scope, scopeId) unique index
 * treats a NULL `scopeId` as DISTINCT) and records a WORM `PipelinePolicyChange`
 * (`beforeJson = null`) for every row it creates. `dnaStyleEnabled` is left NULL
 * (per-doctor storage written separately).
 *
 * Scope guard: this seed touches NO HarnessPolicy gating/threshold/safety columns
 * — it only seeds the realtime-toggle cascade rows.
 */

/** Toggle snapshot mirrored from the runtime PipelinePolicyService change record. */
interface PipelineToggleSnapshot {
  autoSummaryEnabled: boolean | null;
  autoNerEnabled: boolean | null;
  harnessEnabled: boolean | null;
  dnaStyleEnabled: boolean | null;
}

/**
 * SYSTEM-tenant GLOBAL DEFAULT. flipped `harnessEnabled` to `true`
 * (Phase 2 exit criterion) — the legacy signable generator it used to fall
 * back to was deleted in the same ticket.
 */
export const SYSTEM_PIPELINE_POLICY_DEFAULTS = {
  autoSummaryEnabled: true,
  autoNerEnabled: true,
  harnessEnabled: true,
  dnaStyleEnabled: null,
} as const satisfies PipelineToggleSnapshot;

/** DEMO-tenant override — keeps the clinical-workspace harness on (others inherit). */
export const DEMO_PIPELINE_POLICY_OVERRIDE = {
  autoSummaryEnabled: null,
  autoNerEnabled: null,
  harnessEnabled: true,
  dnaStyleEnabled: null,
} as const satisfies PipelineToggleSnapshot;

/**
 * ArcaAI-tenant override — production day-1 tenant routes through the harness
 * (others inherit). `dnaStyleEnabled: true` turns on the per-doctor DNA
 * writing-style gate at the tenant scope; every ArcaAI doctor is seeded with a
 * DNA report (08-dna-writing-style.ts), so the effective gate is satisfied
 * without needing DOCTOR-scope rows.
 */
export const ARCAAI_PIPELINE_POLICY_OVERRIDE = {
  autoSummaryEnabled: null,
  autoNerEnabled: null,
  harnessEnabled: true,
  dnaStyleEnabled: true,
} as const satisfies PipelineToggleSnapshot;

const SYSTEM_REASON =
  ' Phase 5 seed: SYSTEM pipeline cascade default (auto on, harness on — flipped this from off once the legacy signable generator it fell back to was deleted)';
const DEMO_REASON = ' Phase 5 seed: demo-tenant harness override (preserves clinical-workspace harness after UI hard-code removal)';
const ARCAAI_REASON = 'Seed: ArcaAI production day-1 harness override (routes ArcaAI consultations through the documentation harness, mirroring the Global tenant)';

/** Full toggle snapshot from a (possibly partial) row, defaulting absent toggles to null. */
function snapshotToggles(row: Record<string, unknown>): PipelineToggleSnapshot {
  return {
    autoSummaryEnabled: (row.autoSummaryEnabled as boolean | null | undefined) ?? null,
    autoNerEnabled: (row.autoNerEnabled as boolean | null | undefined) ?? null,
    harnessEnabled: (row.harnessEnabled as boolean | null | undefined) ?? null,
    dnaStyleEnabled: (row.dnaStyleEnabled as boolean | null | undefined) ?? null,
  };
}

/**
 * Idempotently ensure one TENANT-scope PipelinePolicy row + its creation WORM
 * change. Returns 'created' when a row was written, 'noop' when it already exists.
 */
async function ensureTenantRow(
  client: CorePrismaClient,
  tenantId: string,
  toggles: PipelineToggleSnapshot,
  reason: string,
): Promise<'created' | 'noop'> {
  const existing = await client.pipelinePolicy.findFirst({
    where: { tenantId, scope: 'TENANT', scopeId: null },
  });
  if (existing) return 'noop';

  const created = await client.pipelinePolicy.create({
    data: {
      tenantId,
      scope: 'TENANT',
      scopeId: null,
      autoSummaryEnabled: toggles.autoSummaryEnabled,
      autoNerEnabled: toggles.autoNerEnabled,
      harnessEnabled: toggles.harnessEnabled,
      dnaStyleEnabled: toggles.dnaStyleEnabled,
      createdBy: SYSTEM_USER_ID,
    },
  });
  await client.pipelinePolicyChange.create({
    data: {
      tenantId,
      scope: 'TENANT',
      scopeId: null,
      changedBy: SYSTEM_USER_ID,
      policyVersion: (created as { version?: number }).version ?? null,
      beforeJson: null as unknown as object,
      afterJson: snapshotToggles(created as Record<string, unknown>) as unknown as object,
      reason,
    },
  });
  return 'created';
}

/**
 * Seed the SYSTEM pipeline-cascade default + the demo-tenant and ArcaAI-tenant
 * harness overrides.
 *
 * Returns the per-row action so callers/tests can assert behavior:
 *   - system: 'created' | 'noop'
 *   - demo: 'created' | 'noop'
 *   - arcaai: 'created' | 'noop'
 */
export const seedPipelinePolicy = async (
  client: CorePrismaClient,
): Promise<{ success: true; system: 'created' | 'noop'; demo: 'created' | 'noop'; arcaai: 'created' | 'noop' }> => {
  console.log('Seeding PipelinePolicy cascade defaults (Phase 5)...');

  const system = await ensureTenantRow(client, SYSTEM_TENANT_ID, SYSTEM_PIPELINE_POLICY_DEFAULTS, SYSTEM_REASON);
  console.log(`  SYSTEM default: ${system}`);

  const demo = await ensureTenantRow(client, SEED_TENANT_ID, DEMO_PIPELINE_POLICY_OVERRIDE, DEMO_REASON);
  console.log(`  Demo-tenant harness override: ${demo}`);

  const arcaai = await ensureTenantRow(client, SEED_CUSTOMER_TENANT_IDS.ARCAAI, ARCAAI_PIPELINE_POLICY_OVERRIDE, ARCAAI_REASON);
  console.log(`  ArcaAI-tenant harness override: ${arcaai}`);

  return { success: true, system, demo, arcaai };
};
