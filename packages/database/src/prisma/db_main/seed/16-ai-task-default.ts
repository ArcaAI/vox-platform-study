import type { CorePrismaClient } from '../../../client';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * AiTaskDefault Seed (centralized task-model configuration)
 *
 * Seeds the SYSTEM-tenant (`00000000-…`) platform defaults for the
 * non-pipeline AI tasks — the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel`:
 *
 *   - guardrail.validate   → granite-guardian-4.1-8b     (GUARDRAIL row)
 *   - nlp.ner              → medical-ner                 (TOKEN_CLASSIFICATION row)
 * - nlp.classification → nlp-doc-type-classifier (TEXT_CLASSIFICATION, DISABLED placeholder — )
 * - nlp.diagnosis → symps-disease-bert-v3-c41 (TEXT_CLASSIFICATION row — )
 * - guardrail.safety → gliner-guard-uniencoder-onnx (TOKEN_CLASSIFICATION row — )
 * - guardrail.groundedness → minicheck-flan-t5-large (TEXT_CLASSIFICATION row — )
 * - harness.judge → lms-gemma-4-e4b (TEXT_GENERATION row — )
 *
 * Resolution at runtime (AiTaskDefaultService.getEffective): tenant row →
 * SYSTEM row → consuming service's env fallback.
 *
 * Governance (owner decision 2026-07-17): ALL task-key prefixes are
 * GLOBAL-ADMIN-ONLY (service-level isSuperAdmin guard on writes) —
 * `guardrail.`, `smr.`, `nlp.`, `harness.` per GLOBAL_ADMIN_ONLY_TASK_PREFIXES
 * in packages/applications/src/services/ai-task-default/constants.ts. Tenants
 * only CONSUME the SYSTEM-row platform default; no task key is tenant-admin
 * editable, and runtime resolution ignores per-tenant override rows.
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
        // repointed at an explicitly DISABLED doc-type placeholder.
        // `nlp.classification` is the `/classify/text` document-type classifier;
        // it no longer points at the diagnosis suggester (moved to nlp.diagnosis).
        // No doc-type model is deployed, so the capability fails closed until a
        // real classifier is seeded. CREATE-ONLY: existing rows keep the admin's
        // choice; only a cold seed picks up the corrected slug.
        id: '86000000-0000-0000-0000-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'nlp.classification',
        modelSlug: 'nlp-doc-type-classifier',
    },
    // the diagnosis suggester is now keyed under `nlp.diagnosis`
    // (the /diagnosis endpoint), separate from the doc-type classifier.
    {
        id: '86000000-0000-0000-0000-000000000009',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'nlp.diagnosis',
        modelSlug: 'symps-disease-bert-v3-c41',
    },
    // SMR generation routing, mapped to the CURRENT SMR
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
    // Guardrail selection moved out of env into the DB control plane
    // (Phase B). Both keys are GLOBAL-ADMIN-only.
    {
        id: '86000000-0000-0000-0000-000000000006',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'guardrail.safety',
        modelSlug: 'gliner-guard-uniencoder-onnx',
    },
    {
        id: '86000000-0000-0000-0000-000000000007',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'guardrail.groundedness',
        modelSlug: 'minicheck-flan-t5-large',
    },
    // Harness LLM-as-judge selection moved out of env into the DB
    // control plane (Phase C). GLOBAL-ADMIN-only; SYSTEM wins.
    {
        id: '86000000-0000-0000-0000-000000000008',
        tenantId: SYSTEM_TENANT_ID,
        taskKey: 'harness.judge',
        modelSlug: 'lms-gemma-4-e4b',
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
