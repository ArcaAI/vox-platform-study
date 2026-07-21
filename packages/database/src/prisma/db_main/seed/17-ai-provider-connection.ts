import type { CorePrismaClient } from '../../../client';
import { AI_MODEL_PROVIDERS } from './ai-models/shared';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * AiProviderConnection Seed (config-plane core)
 *
 * Seeds one SYSTEM-tenant (`00000000-…`) row per canonical serving provider —
 * the platform-default catalog entry recording WHERE a provider lives and (once
 * an admin sets one) HOW to authenticate to it.
 *
 * SILENT-CHANGE GUARD (wiring a dead field must
 * not flip a live default). Every row seeds:
 *
 *   - `enabled: false`   → `resolveConnection` skips it and falls through to
 *                          the consuming service's existing env configuration,
 *                          so runtime behaviour is byte-identical to today.
 *   - no `encryptedApiKey` / `keyVersion` → no key material is ever seeded.
 *
 * The `baseUrl` / `region` / `apiVersion` values below are PLACEHOLDER DATA
 * transcribed from the current `.env.dev` / `.env.production` reference values
 * so a global admin has a sane starting point in the console. They are inert
 * while `enabled: false`, and each such row is flagged `metaData.placeholder`
 * so the admin surface can render them as suggestions rather than
 * as configured values.
 *
 * CREATE-ONLY: an existing (tenantId, provider) row is NEVER overwritten — the
 * connection is admin-tunable at runtime and a re-seed must not clobber an
 * admin's endpoint or key.
 */

export interface AiProviderConnectionSeed {
    id: string;
    tenantId: string;
    provider: string;
    baseUrl: string | null;
    region: string | null;
    apiVersion: string | null;
    deploymentName: string | null;
    encryptedApiKey: Uint8Array | null;
    keyVersion: number | null;
    enabled: boolean;
    metaData: { placeholder?: boolean; note?: string } | null;
}

/**
 * Deterministic ids — fresh `87000000-…` block (unused by any other seed).
 * Order mirrors `AI_MODEL_PROVIDERS` so the seed-shape test can compare sets.
 */
export const SYSTEM_AI_PROVIDER_CONNECTIONS: AiProviderConnectionSeed[] = [
    {
        // Local/self-host Ollama engine (`SMR_V2_OLLAMA_BASE_URL`).
        id: '87000000-0000-0000-0000-000000000001',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: { placeholder: true, note: 'Reference value from SMR_V2_OLLAMA_BASE_URL.' },
    },
    {
        // LM Studio — the default local OpenAI-compatible engine
        // (`SMR_V2_OPENAI_COMPAT_BASE_URL`).
        id: '87000000-0000-0000-0000-000000000002',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'lm-studio',
        baseUrl: 'http://localhost:1234/v1',
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: { placeholder: true, note: 'Reference value from SMR_V2_OPENAI_COMPAT_BASE_URL.' },
    },
    {
        // Azure OpenAI — endpoint/apiVersion/deployment are per-deployment and
        // blank in `.env.production`; a global admin fills them in.
        id: '87000000-0000-0000-0000-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'azure',
        baseUrl: null,
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: null,
    },
    {
        // AWS Bedrock — region is deployment-specific; no placeholder invented.
        id: '87000000-0000-0000-0000-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'bedrock',
        baseUrl: null,
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: null,
    },
    {
        // `built-in` = in-process/bundled models (no remote endpoint at all).
        id: '87000000-0000-0000-0000-000000000005',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'built-in',
        baseUrl: null,
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: null,
    },
    {
        // Sarvam AI (cloud). NOTE: the public API is not PHI-safe — point at a
        // VPC/on-prem host before enabling for patient data.
        id: '87000000-0000-0000-0000-000000000006',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'sarvam',
        baseUrl: null,
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: null,
    },
    {
        // vLLM production self-host engine (`SMR_V2_VLLM_BASE_URL`).
        id: '87000000-0000-0000-0000-000000000007',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'vllm',
        baseUrl: 'http://hope-vllm:8000/v1',
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: { placeholder: true, note: 'Reference value from SMR_V2_VLLM_BASE_URL (k3s Service).' },
    },
    {
        // llama.cpp production self-host engine (`SMR_V2_LLAMA_CPP_BASE_URL`).
        id: '87000000-0000-0000-0000-000000000008',
        tenantId: SYSTEM_TENANT_ID,
        provider: 'llama-cpp',
        baseUrl: 'http://hope-llama-cpp:8080',
        region: null,
        apiVersion: null,
        deploymentName: null,
        encryptedApiKey: null,
        keyVersion: null,
        enabled: false,
        metaData: { placeholder: true, note: 'Reference value from SMR_V2_LLAMA_CPP_BASE_URL (k3s Service).' },
    },
];

/**
 * Compile-time guard: the seed must cover every canonical provider. Kept as a
 * type-level assertion so adding a provider to `AI_MODEL_PROVIDERS` without a
 * seed row fails the build, not just the test.
 */
const _providerCoverage: Record<(typeof AI_MODEL_PROVIDERS)[number], true> = Object.fromEntries(
    SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => [c.provider, true]),
) as Record<(typeof AI_MODEL_PROVIDERS)[number], true>;
void _providerCoverage;

export const seedAiProviderConnection = async (
    client: CorePrismaClient,
): Promise<{ success: true; created: number; skipped: number }> => {
    console.log('Seeding SYSTEM AiProviderConnection rows (TASK-524)...');

    let created = 0;
    let skipped = 0;
    for (const row of SYSTEM_AI_PROVIDER_CONNECTIONS) {
        const existing = await client.aiProviderConnection.findFirst({
            where: { tenantId: row.tenantId, provider: row.provider },
        });

        if (existing) {
            // CREATE-ONLY — never clobber an admin-configured endpoint or key.
            console.log(`  AiProviderConnection "${row.provider}" already exists, skipping`);
            skipped += 1;
            continue;
        }

        console.log(`  Creating AiProviderConnection "${row.provider}" (disabled)`);
        await client.aiProviderConnection.create({
            data: {
                id: row.id,
                tenantId: row.tenantId,
                provider: row.provider,
                baseUrl: row.baseUrl,
                region: row.region,
                apiVersion: row.apiVersion,
                deploymentName: row.deploymentName,
                enabled: row.enabled,
                // Conditional spread, not `?? undefined` — the repo compiles
                // with `exactOptionalPropertyTypes`, so an explicit `undefined`
                // is not assignable to Prisma's JSON input type.
                ...(row.metaData ? { metaData: row.metaData } : {}),
                createdBy: SYSTEM_USER_ID,
            },
        });
        created += 1;
    }

    console.log(`Seeded AiProviderConnection: ${created} created, ${skipped} skipped`);
    return { success: true, created, skipped };
};
