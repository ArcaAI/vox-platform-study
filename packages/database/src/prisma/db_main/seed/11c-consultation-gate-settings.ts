/**
 * Consultation-Gate Settings Seed
 *
 * Turns the consultation-pipeline kill-switch ON for every environment that
 * seeds — including a fresh local `pnpm setup:dev`:
 *
 *   consultation.ocr.enabled the in-cluster PyMuPDF + RapidOCR pass that fills
 *                             `ContextItem.metaData.extractedText`
 *
 * ⚠️ — `harness.loop.enabled` USED TO BE SEEDED HERE AND IS NOT ANY
 * MORE. Do not add it back. Seeding it `'true'` while its descriptor declared
 * `false` was a real defect, not a clever workaround: the two disagreed, and
 * `migrate.sh` defaults `RUN_SEED=none` (with `hope-v2-dev` pinning it to
 * `"none"` by owner decision 2026-08-09), so the row carrying the real intent
 * was never re-asserted anywhere. Loop eligibility is now the tenant's
 * SUBSCRIPTION ENTITLEMENT (`agenticLoop`, resolved from `PlanEntitlement` /
 * `TenantEntitlement` — owner decision 2026-08-17 row 705), and what remains
 * of the operational device is `harness.loop.emergencyStop`, whose disarmed
 * `false` default IS the intended day-1 state. There is nothing left to seed.
 *
 * WHY A SEEDED ROW AND NOT A DESCRIPTOR DEFAULT (for the OCR gate below). It is
 * a registered kill-switch, and `SettingsRegistry.killSwitches()` THROWS at
 * assembly for any kill-switch whose `default === true`. That invariant is not
 * in the way — it is the reason the shape below is correct:
 *
 *   descriptor default stays OFF → an unseeded / half-provisioned deployment
 *                                    still resolves OFF, which is fail-safe
 *   the seeded ROW carries 'true' → every seeded environment comes up enabled
 *   `defaultValue` stays 'false' → "reset to default" reverts to fail-safe
 *
 * This is the same sanctioned pattern `11-global-setting.ts` already uses twice,
 * for `pipeline.templateResync.enabled` and `departmentAgent.templateResync
 * .enabled`; that file's comment spells out the reasoning at length.
 *
 * ROW COORDINATES ARE LOAD-BEARING. `SettingsRegistryWriteService` finds an
 * existing row by `(key, namespace='registry', tenantId=SYSTEM)` and, failing
 * that, CREATES one named `descriptor.label`. `GlobalSetting` is unique on
 * `(tenantId, name, key)`. Seed a different tenant, namespace or name and the
 * operator's first `PUT` creates a SECOND platform row for the same key — which
 * `AppSettingsService` refuses to boot on. So the rows below use
 * `SYSTEM_TENANT_ID` (`00000000-…` — the sole platform-configuration tier;
 * owner ruling 2026-08-20), namespace `registry`, and names
 * copied verbatim from the descriptor labels. `consultation-gate-seed-parity.test.ts`
 * in `@arcaai/applications` holds all four coordinates to the registry, because
 * `packages/database` must not depend on `@arcaai/applications`.
 *
 * IDEMPOTENT, and CREATE-ONLY for the `value` column: a re-seed refreshes
 * metadata but never clobbers an operator who turned a switch back off. That is
 * what makes `pnpm db:seed` safe against a live database, and it is enforced
 * repo-wide by `seed/__tests__/seed-idempotency.test.ts`.
 *
 * Disabling the switch afterwards is one call, no redeploy:
 *   PUT /api/v1/admin/settings/registry/consultation.ocr.enabled { "value": false }
 *
 * The loop's emergency stop is pulled the same way, in the opposite direction:
 *   PUT /api/v1/admin/settings/registry/harness.loop.emergencyStop { "value": true }
 */
import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_USER_IDS } from './00-constants';

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

export const GATES: GateSeed[] = [
    {
      key: 'consultation.realtime.graphExecutor.enabled',
      name: 'Realtime graph executor',
      value: 'true',
      defaultValue: 'false',
      description:
        "Routes the live consultation through the tenant's PUBLISHED workflow graph instead of the hardcoded legacy flush(). Without this row the descriptor default (OFF) wins everywhere, so a tenant admin can author, validate, publish and assign a six-stage realtime graph while the running session ignores every realtime node in it - authoring becomes a picture rather than the engine. Seeded ON as the platform default a tenant inherits absent its own opinion; defaultValue stays at the fail-safe so a reset-to-default still falls back to the legacy engine, and per-tenant rollout remains possible (maxScope 'tenant'). Locked - only SUPER_ADMIN may change it.",
    },
  {
    key: 'consultation.ocr.enabled',
    name: 'Server-side OCR enrichment',
    value: 'true',
    defaultValue: 'false',
    description:
      'Enables OcrEnrichmentProcessor — the in-cluster PyMuPDF + RapidOCR pass that fills ContextItem.metaData.extractedText for scanned attachments the browser text-layer extractor could not read. Restores the effective behaviour of the retired OCR_ENABLED env flag, which defaulted ON. PHI posture unchanged (bytes stay in-cluster). Locked — only SUPER_ADMIN may change it.',
  },
];

export const seedConsultationGateSettings = async (client: CorePrismaClient): Promise<void> => {
  console.log(`Seeding consultation-gate Global Settings (${GATES.length} platform rows, namespace='${NAMESPACE}')...`);

  for (const gate of GATES) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: SYSTEM_TENANT_ID,
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
        tenantId: SYSTEM_TENANT_ID,
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
