import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * AiTaskDefault Seed (TASK-506 — centralized task-model configuration)
 *
 * Seeds the SYSTEM-tenant (`00000000-…`) platform defaults for the
 * non-pipeline AI tasks — the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel`:
 *
 *   - guardrail.validate   → granite-guardian-4.1-8b   (GUARDRAIL row)
 *   - nlp.ner              → medical-ner               (TOKEN_CLASSIFICATION row)
 *   - nlp.classification   → symps-disease-bert-v3-c41 (TEXT_CLASSIFICATION row)
 *
 * Resolution at runtime (AiTaskDefaultService.getEffective): tenant row →
 * SYSTEM row → consuming service's env fallback. Governance (owner decision
 * 2026-07-17): `guardrail.*` keys are GLOBAL-ADMIN-ONLY at the service layer;
 * `nlp.*` keys are tenant-admin editable via manage:AiTaskDefault.
 *
 * CREATE-ONLY: an existing (tenantId, taskKey) row is NEVER overwritten — the
 * platform default is admin-tunable at runtime and a re-seed must not clobber
 * an admin's choice. Depends on the AiModel catalog (seedStt) for the slugs.
 */

export interface AiTaskDefaultSeed {
    id: string;
    tenantId: string;
    taskKey: string;
    modelSlug: string;
}

/** Deterministic ids — fresh `86000000-…` block (unused by any other seed). */
export const SYSTEM_AI_TASK_DEFAULTS: AiTaskDefaultSeed[] = [
    {
        id: '86000000-0000-0000-0000-000000000001',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'guardrail.validate',
        modelSlug: 'granite-guardian-4.1-8b',
    },
    {
        id: '86000000-0000-0000-0000-000000000002',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'nlp.ner',
        modelSlug: 'medical-ner',
    },
    {
        id: '86000000-0000-0000-0000-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'nlp.classification',
        modelSlug: 'symps-disease-bert-v3-c41',
    },
    // TASK-511 (Phase 3A) — SMR generation routing, mapped to the CURRENT SMR
    // default (HarnessPolicy SYSTEM smrProvider/smrModel = lm-studio /
    // gemma-4-e2b-it-qat, registry slug `lms-gemma-4-e2b-it-qat`). Both live and
    // finalize point at the same platform default today; a global admin may
    // split them later. `resolveSmrSelection` consults these keys FIRST.
    {
        id: '86000000-0000-0000-0000-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'smr.live',
        modelSlug: 'lms-gemma-4-e2b-it-qat',
    },
    {
        id: '86000000-0000-0000-0000-000000000005',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'smr.finalize',
        modelSlug: 'lms-gemma-4-e2b-it-qat',
    },
];

export const seedAiTaskDefault = async (
    client: CorePrismaClient,
): Promise<{ success: true; created: number; skipped: number }> => {
    console.log('Seeding SYSTEM AiTaskDefault rows (TASK-506)...');

    let created = 0;
    let skipped = 0;
    for (const row of SYSTEM_AI_TASK_DEFAULTS) {
        const existing = await client.aiTaskDefault.findFirst({
            where: { tenantId: row.tenantId, taskKey: row.taskKey },
        });

        if (existing) {
            // CREATE-ONLY — never overwrite an admin-managed default.
            console.log(`  AiTaskDefault "${row.taskKey}" already exists, skipping`);
            skipped += 1;
            continue;
        }

        console.log(`  Creating AiTaskDefault "${row.taskKey}" → ${row.modelSlug}`);
        await client.aiTaskDefault.create({
            data: {
                id: row.id,
                tenantId: row.tenantId,
                taskKey: row.taskKey,
                modelSlug: row.modelSlug,
                createdBy: SYSTEM_USER_ID,
            },
        });
        created += 1;
    }

    console.log(`Seeded AiTaskDefault: ${created} created, ${skipped} skipped`);
    return { success: true, created, skipped };
};
