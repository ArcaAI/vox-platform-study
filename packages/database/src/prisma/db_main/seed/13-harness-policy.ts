import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * HarnessPolicy Seed (TEXT default wiring)
 *
 * The reserved system tenant (`00000000-…`, SYSTEM_TENANT_ID) owns the
 * GLOBAL-DEFAULT HarnessPolicy row that the clinical documentation loop reads
 * via its `fetch_policy` activity (apps/harness). This seed sets the TEXT
 * generation default on that row:
 *   - textProvider = 'lm-studio'
 *   - textModel    = 'gemma-4-e2b-it-qat'
 * (both were NULL → "let the TEXT service choose"; the model
 * default moved from `gemma-4-e2b-it-sft-rlvr-medical` to the owner-declared
 * platform default `gemma-4-e2b-it-qat` — registry row `lms-gemma-4-e2b-it-qat`).
 *
 * This step writes ONLY those two columns and is idempotent. It ALSO records a
 * WORM `HarnessPolicyChange` audit entry for the default-set, mirroring the
 * runtime HarnessPolicyService.upsert mechanism (before/after knob snapshots;
 * `beforeJson = null` denotes the row was created by this change). The
 * HarnessPolicyChange table is append-only (the migration REVOKEs UPDATE/DELETE
 * from the app role), so only INSERTs happen here.
 *
 * Scope guard: this seed touches NO gating/threshold/safety columns. It only sets the
 * two TEXT columns.
 */

/** The agreed TEXT system default (overrides the NULL "service chooses"). */
export const SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS = {
  textProvider: 'lm-studio',
  // Owner decision (2026-07-17) — the platform summarization
  // default is gemma-4-e2b-it-qat (was gemma-4-e2b-it-sft-rlvr-medical).
  textModel: 'gemma-4-e2b-it-qat',
} as const;

/**
 * The HarnessPolicy runtime knobs, with their code defaults. Kept in
 * lock-step with `HARNESS_POLICY_DEFAULTS` (@arcaai/domains) + the Prisma column
 * `@default`s in harness.prisma so the WORM snapshot has the same shape the
 * runtime service writes. The seed lives in @arcaai/database and must not import
 * the domain/application layers, hence this local mirror.
 */
const HARNESS_POLICY_KNOB_DEFAULTS = {
  entityFaithfulnessThreshold: 1.0,
  coverageThreshold: 0.8,
  citationPresenceThreshold: 1.0,
  numericDoseThreshold: 1.0,
  groundednessThreshold: 0.8,
  safetyEnabled: true,
  phiEnabled: true,
  phiFailClosed: true,
  textProvider: null as string | null,
  textModel: null as string | null,
  maxRegen: 2,
  gateSlaSeconds: 86400,
  gateEscalationSeconds: 43200,
  toolAllowlist: null as unknown,
} as const;

type HarnessPolicyKnobs = Record<keyof typeof HARNESS_POLICY_KNOB_DEFAULTS, unknown>;

/**
 * Build a full 16-knob snapshot from a (possibly partial) policy row, falling
 * back to the code defaults for any column the row does not carry. `??` is used
 * so a legitimate `false`/`0`/explicit `null` is preserved (the TEXT defaults are
 * `null`, so a null row value collapses to the null default either way).
 */
function snapshotKnobs(row: Record<string, unknown>): HarnessPolicyKnobs {
  const out = {} as HarnessPolicyKnobs;
  for (const key of Object.keys(HARNESS_POLICY_KNOB_DEFAULTS) as (keyof typeof HARNESS_POLICY_KNOB_DEFAULTS)[]) {
    out[key] = row[key] ?? HARNESS_POLICY_KNOB_DEFAULTS[key];
  }
  return out;
}

const SEED_CHANGE_REASON = 'TASK-506 seed: set TEXT system default (lm-studio / gemma-4-e2b-it-qat)';

/**
 * Idempotently set the SYSTEM HarnessPolicy TEXT default + record a WORM change.
 *
 * Returns the action taken so callers/tests can assert behaviour:
 *   - 'created' — no SYSTEM row existed; created with the TEXT default (+ WORM, beforeJson=null)
 *   - 'updated' — a row existed without the TEXT default; only the two TEXT columns written (+ WORM before/after)
 *   - 'noop'    — the TEXT default was already set; nothing written
 */
export const seedHarnessPolicy = async (
  client: CorePrismaClient,
): Promise<{ success: true; action: 'created' | 'updated' | 'noop'; changeWritten: boolean }> => {
  console.log('Seeding SYSTEM HarnessPolicy TEXT default (TASK-356 Phase 2)...');

  const { textProvider, textModel } = SYSTEM_HARNESS_POLICY_TEXT_DEFAULTS;
  const existing = await client.harnessPolicy.findFirst({
    where: { tenantId: SYSTEM_TENANT_ID },
  });

  // Idempotent: the TEXT default is already set — nothing to write or audit.
  if (existing && existing.textProvider === textProvider && existing.textModel === textModel) {
    console.log('  SYSTEM HarnessPolicy TEXT default already set, skipping');
    return { success: true, action: 'noop', changeWritten: false };
  }

  if (!existing) {
    // Create the SYSTEM row with the TEXT default. All other knobs come from
    // the Prisma column @defaults (granite safety model, code thresholds…).
    const created = await client.harnessPolicy.create({
      data: {
        tenantId: SYSTEM_TENANT_ID,
        textProvider,
        textModel,
        createdBy: SYSTEM_USER_ID,
      },
    });
    await client.harnessPolicyChange.create({
      data: {
        tenantId: SYSTEM_TENANT_ID,
        changedBy: SYSTEM_USER_ID,
        policyVersion: (created as { version?: number }).version ?? null,
        beforeJson: null as unknown as object,
        afterJson: snapshotKnobs(created as Record<string, unknown>) as unknown as object,
        reason: SEED_CHANGE_REASON,
      },
    });
    console.log('  Created SYSTEM HarnessPolicy with TEXT default + WORM change');
    return { success: true, action: 'created', changeWritten: true };
  }

  // A row exists but the TEXT default is unset/stale — write ONLY the two TEXT
  // columns (never clobber other admin-changed knobs) + a before/after WORM.
  const before = snapshotKnobs(existing as Record<string, unknown>);
  const updated = await client.harnessPolicy.update({
    where: { id: (existing as { id: string }).id },
    data: { textProvider, textModel },
  });
  await client.harnessPolicyChange.create({
    data: {
      tenantId: SYSTEM_TENANT_ID,
      changedBy: SYSTEM_USER_ID,
      policyVersion: (updated as { version?: number }).version ?? null,
      beforeJson: before as unknown as object,
      afterJson: snapshotKnobs(updated as Record<string, unknown>) as unknown as object,
      reason: SEED_CHANGE_REASON,
    },
  });
  console.log('  Updated SYSTEM HarnessPolicy TEXT default + WORM change');
  return { success: true, action: 'updated', changeWritten: true };
};
