import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * HarnessPolicy Seed — the SYSTEM global-default row.
 *
 * The reserved system tenant (`00000000-…`, SYSTEM_TENANT_ID) owns the
 * GLOBAL-DEFAULT HarnessPolicy row that the clinical documentation loop reads
 * via its `fetch_policy` activity (apps/harness) and that every tenant's
 * effective policy widens to. This seed ensures that row EXISTS; every knob
 * comes from the Prisma column `@default`s.
 *
 * TASK-881: it used to ALSO write the TEXT generation default
 * (`textProvider = 'lm-studio'`, `textModel = 'gemma-4-e2b-it-qat'`) onto the
 * row. Both columns are dropped — text selection is the tenant's assigned
 * TEXT_GENERATION agent (TASK-876), and the effective-policy response derives
 * `textProvider` / `textModel` from that agent's primary. What survives is the
 * CREATE-ONLY posture and the WORM `HarnessPolicyChange` audit entry for the
 * creation (`beforeJson = null` denotes the row was created by this change).
 * The HarnessPolicyChange table is append-only (the migration REVOKEs
 * UPDATE/DELETE from the app role), so only INSERTs happen here.
 *
 * Scope guard: this seed touches NO gating/threshold/safety columns and never
 * updates an existing row — an admin's runtime edits survive a re-seed.
 */

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
  maxRegen: 2,
  gateSlaSeconds: 86400,
  gateEscalationSeconds: 43200,
  toolAllowlist: null as unknown,
} as const;

type HarnessPolicyKnobs = Record<keyof typeof HARNESS_POLICY_KNOB_DEFAULTS, unknown>;

/**
 * Build a full knob snapshot from a (possibly partial) policy row, falling
 * back to the code defaults for any column the row does not carry. `??` is used
 * so a legitimate `false`/`0`/explicit `null` is preserved.
 */
function snapshotKnobs(row: Record<string, unknown>): HarnessPolicyKnobs {
  const out = {} as HarnessPolicyKnobs;
  for (const key of Object.keys(HARNESS_POLICY_KNOB_DEFAULTS) as (keyof typeof HARNESS_POLICY_KNOB_DEFAULTS)[]) {
    out[key] = row[key] ?? HARNESS_POLICY_KNOB_DEFAULTS[key];
  }
  return out;
}

const SEED_CHANGE_REASON = ' seed: create the SYSTEM global-default HarnessPolicy row';

/**
 * Idempotently ensure the SYSTEM HarnessPolicy row exists + record a WORM change on creation.
 *
 * Returns the action taken so callers/tests can assert behaviour:
 *   - 'created' — no SYSTEM row existed; created from the column defaults (+ WORM, beforeJson=null)
 *   - 'noop'    — the SYSTEM row already exists; nothing written (CREATE-ONLY, never an update)
 */
export const seedHarnessPolicy = async (client: CorePrismaClient): Promise<{ success: true; action: 'created' | 'noop'; changeWritten: boolean }> => {
  console.log('Seeding SYSTEM HarnessPolicy global-default row ...');

  const existing = await client.harnessPolicy.findFirst({
    where: { tenantId: SYSTEM_TENANT_ID },
  });

  if (existing) {
    console.log('  SYSTEM HarnessPolicy row exists — KEPT AS IS (create-only)');
    return { success: true, action: 'noop', changeWritten: false };
  }

  const created = await client.harnessPolicy.create({
    data: {
      tenantId: SYSTEM_TENANT_ID,
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
  console.log('  Created SYSTEM HarnessPolicy row + WORM change');
  return { success: true, action: 'created', changeWritten: true };
};
