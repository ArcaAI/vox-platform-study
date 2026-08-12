/**
 * Consultation-Gate Settings Seed (TASK-684)
 *
 * Turns the two consultation-pipeline kill-switches ON for every environment
 * that seeds — including a fresh local `pnpm setup:dev`:
 *
 *   harness.loop.enabled      the ContextAdded / consultation-ending /
 *                             loop-cancel signals sent to the
 *                             `ConsultationLoopWorkflow` in apps/harness
 *   consultation.ocr.enabled  the in-cluster PyMuPDF + RapidOCR pass that fills
 *                             `ContextItem.metaData.extractedText`
 *
 * WHY A SEEDED ROW AND NOT A DESCRIPTOR DEFAULT. Both keys are registered
 * kill-switches, and `SettingsRegistry.killSwitches()` THROWS at assembly for
 * any kill-switch whose `default === true`. That invariant is not in the way of
 * this ticket — it is the reason the shape below is correct:
 *
 *   descriptor default stays OFF  →  an unseeded / half-provisioned deployment
 *                                    still resolves OFF, which is fail-safe
 *   the seeded ROW carries 'true' →  every seeded environment comes up enabled
 *   `defaultValue` stays 'false'  →  "reset to default" reverts to fail-safe
 *
 * This is the same sanctioned pattern `11-global-setting.ts` already uses twice,
 * for `pipeline.templateResync.enabled` and `departmentAgent.templateResync
 * .enabled`; that file's comment spells out the reasoning at length.
 *
 * ROW COORDINATES ARE LOAD-BEARING. `SettingsRegistryWriteService` finds an
 * existing row by `(key, namespace='registry', tenantId=GLOBAL)` and, failing
 * that, CREATES one named `descriptor.label`. `GlobalSetting` is unique on
 * `(tenantId, name, key)`. Seed a different tenant, namespace or name and the
 * operator's first `PUT` creates a SECOND platform row for the same key — which
 * `AppSettingsService` refuses to boot on. So the rows below use
 * `SEED_TENANT_ID` (`50000000-…`), namespace `registry`, and names copied
 * verbatim from the descriptor labels. `consultation-gate-seed-parity.test.ts`
 * in `@arcaai/applications` holds all four coordinates to the registry, because
 * `packages/database` must not depend on `@arcaai/applications`.
 *
 * IDEMPOTENT, and CREATE-ONLY for the `value` column: a re-seed refreshes
 * metadata but never clobbers an operator who turned a switch back off. That is
 * what makes `pnpm db:seed` safe against a live database, and it is enforced
 * repo-wide by `seed/__tests__/seed-idempotency.test.ts`.
 *
 * Disabling either switch afterwards is one call, no redeploy:
 *   PUT /api/v1/admin/settings/registry/harness.loop.enabled  { "value": false }
 */
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_USER_IDS } from './00-constants';

const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

/** The namespace `SettingsRegistryWriteService` stamps on every registry row. */
const NAMESPACE = 'registry';

interface GateSeed {
  /** Registry descriptor key. */
  key: string;
  /** Human label — must match the descriptor's `label` verbatim (row identity). */
  name: string;
  /** Seeded ON. The descriptor default stays OFF; this row is what enables it. */
  value: string;
  /** Stays at the fail-safe, so a "reset to default" disables the switch. */
  defaultValue: string;
  description: string;
}

const GATES: GateSeed[] = [
  {
    key: 'harness.loop.enabled',
    name: 'Consultation loop signalling',
    value: 'true',
    defaultValue: 'false',
    description:
      'Enables LoopContextSignalService — the ContextAdded / consultation-ending / loop-cancel signals sent to the ConsultationLoopWorkflow in apps/harness. Enabled on day 1 in every environment. Signalling is best-effort: with the harness or Temporal unreachable the consultation lifecycle is unaffected. Locked — only GLOBAL_ADMIN may change it.',
  },
  {
    key: 'consultation.ocr.enabled',
    name: 'Server-side OCR enrichment',
    value: 'true',
    defaultValue: 'false',
    description:
      'Enables OcrEnrichmentProcessor — the in-cluster PyMuPDF + RapidOCR pass that fills ContextItem.metaData.extractedText for scanned attachments the browser text-layer extractor could not read. Restores the effective behaviour of the retired OCR_ENABLED env flag, which defaulted ON. PHI posture unchanged (bytes stay in-cluster). Locked — only GLOBAL_ADMIN may change it.',
  },
];

export const seedConsultationGateSettings = async (client: CorePrismaClient): Promise<void> => {
  console.log(`Seeding consultation-gate Global Settings (${GATES.length} platform rows, namespace='${NAMESPACE}')...`);

  for (const gate of GATES) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: SEED_TENANT_ID,
          name: gate.name,
          key: gate.key,
        },
      },
      // Idempotent: refresh code-owned metadata but NEVER clobber an operator
      // who turned the switch back off — `value` is create-only.
      update: {
        defaultValue: gate.defaultValue,
        dataType: ValueType.Boolean,
        description: gate.description,
        namespace: NAMESPACE,
        locked: true,
      },
      create: {
        tenantId: SEED_TENANT_ID,
        namespace: NAMESPACE,
        name: gate.name,
        key: gate.key,
        value: gate.value,
        defaultValue: gate.defaultValue,
        dataType: ValueType.Boolean,
        description: gate.description,
        locked: true,
        createdBy: CREATED_BY,
      },
    });
    // NB: this reports what a FIRST seed writes. On a re-seed the `value`
    // column is deliberately left alone, so a switch an operator turned off
    // stays off — do not read this line as "the row is now `value`".
    console.log(`  ${NAMESPACE}/${gate.key} → ${gate.value} on create (default ${gate.defaultValue}; existing value preserved)`);
  }

  console.log(`Seeded ${GATES.length} consultation-gate Global Settings`);
};
