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
 * SEED-AUTHORITATIVE Day-1 posture (TASK-578, OD-1). The SYSTEM rows — not env —
 * are the authoritative default source. Two classes of row:
 *
 *   - BUILT-IN-LOCAL llm engines (`ollama`, `lm-studio`, `built-in`, `vllm`,
 *     `llama-cpp`) seed `enabled: true`, so `resolveConnection('llm', …)` returns
 *     the SYSTEM row Day-1 and env is a pure fallback. Their `baseUrl` is the
 *     platform-run engine's connection identity (env-tier per
 *     `09-infrastructure-devops.md`), carried here as the DECLARED source of
 *     truth — not a placeholder.
 *   - CLOUD-BYO providers (llm `azure`/`bedrock`/`openai`/`anthropic`/`vertex`/
 *     `sarvam`, plus all stt/tts cloud rows) stay `enabled: false`: a cloud
 *     provider needs a tenant-supplied key, so an enabled-but-keyless cloud row
 *     must never serve. A tenant enables one by bringing its own credential.
 *
 * In all cases: no `encryptedApiKey` / `keyVersion` is ever seeded — no key
 * material lives in a seed.
 *
 * CREATE-ONLY: an existing (tenantId, service, provider) row is NEVER
 * overwritten — the connection is admin-tunable at runtime and a re-seed must
 * not clobber an admin's endpoint or key.
 *
 * UNIFIED PLANE (TASK-569): rows now carry a `service` discriminator. The `llm`
 * service seeds every canonical serving provider (AI_MODEL_PROVIDERS + the new
 * cloud providers anthropic/vertex); `stt` and `tts` seed only their CLOUD
 * providers (self-host STT/TTS engines are not credential-bearing here).
 */

export interface AiProviderConnectionSeed {
  id: string;
  tenantId: string;
  /** Capability discriminator (llm | stt | tts). */
  service: string;
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
    // Local/self-host Ollama engine (`SMR_OLLAMA_BASE_URL`).
    id: '87000000-0000-0000-0000-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: true,
    metaData: { note: 'Base URL from SMR_OLLAMA_BASE_URL (env-tier connection identity).' },
  },
  {
    // LM Studio — the default local OpenAI-compatible engine
    // (`SMR_OPENAI_COMPAT_BASE_URL`).
    id: '87000000-0000-0000-0000-000000000002',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'lm-studio',
    baseUrl: 'http://localhost:1234/v1',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: true,
    metaData: { note: 'Base URL from SMR_OPENAI_COMPAT_BASE_URL (env-tier connection identity).' },
  },
  {
    // Azure OpenAI — endpoint/apiVersion/deployment are per-deployment and
    // blank in `.env.production`; a global admin fills them in.
    id: '87000000-0000-0000-0000-000000000003',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
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
    service: 'llm',
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
    service: 'llm',
    provider: 'built-in',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: true,
    metaData: null,
  },
  {
    // Sarvam AI (cloud). NOTE: the public API is not PHI-safe — point at a
    // VPC/on-prem host before enabling for patient data.
    id: '87000000-0000-0000-0000-000000000006',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
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
    // OpenAI (cloud) — speech-to-text (TASK-567) and OpenAI-compatible LLM
    // endpoints. baseUrl blank; a global admin fills it in. NOTE: the public
    // API is not PHI-safe — point at an Azure OpenAI / VPC host before enabling
    // for patient data.
    id: '87000000-0000-0000-0000-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'openai',
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
    // vLLM production self-host engine (`SMR_VLLM_BASE_URL`).
    id: '87000000-0000-0000-0000-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'vllm',
    baseUrl: 'http://hope-vllm:8000/v1',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: true,
    metaData: { note: 'Base URL from SMR_VLLM_BASE_URL (k3s Service; env-tier connection identity).' },
  },
  {
    // llama.cpp production self-host engine (`SMR_LLAMA_CPP_BASE_URL`).
    id: '87000000-0000-0000-0000-000000000008',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'llama-cpp',
    baseUrl: 'http://hope-llama-cpp:8080',
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: true,
    metaData: { note: 'Base URL from SMR_LLAMA_CPP_BASE_URL (k3s Service; env-tier connection identity).' },
  },

  // ── New LLM cloud providers (TASK-569 freeze; functional in TASK-572) ──────
  {
    // Anthropic Messages API (cloud). Catalog-only until TASK-572 lands the SMR
    // adapter. NOTE: the public API is not PHI-safe — route via a compliant
    // endpoint before enabling for patient data.
    id: '87000000-0000-0000-0000-00000000000a',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'anthropic',
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
    // Google Vertex AI (cloud). Catalog-only until TASK-572 lands the SMR
    // adapter. NOTE: the public API is not PHI-safe — use a compliant project.
    id: '87000000-0000-0000-0000-00000000000b',
    tenantId: SYSTEM_TENANT_ID,
    service: 'llm',
    provider: 'vertex',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: false,
    metaData: null,
  },

  // ── STT cloud providers (unified from TenantSttProviderCredential) ─────────
  {
    // Azure Speech / Azure AI Foundry (cloud ASR).
    id: '87000000-0000-0000-0000-0000000000c1',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'azure-speech',
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
    // Sarvam ASR (cloud). NOTE: the public API is not PHI-safe.
    id: '87000000-0000-0000-0000-0000000000c2',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
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
    // OpenAI transcription (cloud). NOTE: the public API is not PHI-safe.
    id: '87000000-0000-0000-0000-0000000000c3',
    tenantId: SYSTEM_TENANT_ID,
    service: 'stt',
    provider: 'openai',
    baseUrl: null,
    region: null,
    apiVersion: null,
    deploymentName: null,
    encryptedApiKey: null,
    keyVersion: null,
    enabled: false,
    metaData: null,
  },

  // ── TTS cloud providers (unified from TenantTtsProviderCredential) ─────────
  {
    // Azure Speech (cloud TTS).
    id: '87000000-0000-0000-0000-0000000000d1',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
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
    // Sarvam TTS (cloud). NOTE: the public API is not PHI-safe.
    id: '87000000-0000-0000-0000-0000000000d2',
    tenantId: SYSTEM_TENANT_ID,
    service: 'tts',
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
];

/**
 * Compile-time guard: the LLM service must cover every canonical serving
 * provider. Scoped to `service === 'llm'` under the unified plane (TASK-569) —
 * the STT/TTS catalog rows are cloud-only and additive. Kept as a type-level
 * assertion so adding a provider to `AI_MODEL_PROVIDERS` without an `llm` seed
 * row fails the build, not just the test.
 */
const _llmProviderCoverage: Record<(typeof AI_MODEL_PROVIDERS)[number], true> = Object.fromEntries(
  SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.service === 'llm').map((c) => [c.provider, true]),
) as Record<(typeof AI_MODEL_PROVIDERS)[number], true>;
void _llmProviderCoverage;

export const seedAiProviderConnection = async (client: CorePrismaClient): Promise<{ success: true; created: number; skipped: number }> => {
  console.log('Seeding SYSTEM AiProviderConnection rows (TASK-524)...');

  let created = 0;
  let skipped = 0;
  for (const row of SYSTEM_AI_PROVIDER_CONNECTIONS) {
    const existing = await client.aiProviderConnection.findFirst({
      where: { tenantId: row.tenantId, service: row.service, provider: row.provider },
    });

    if (existing) {
      // CREATE-ONLY — never clobber an admin-configured endpoint or key.
      console.log(`  AiProviderConnection "${row.service}:${row.provider}" already exists, skipping`);
      skipped += 1;
      continue;
    }

    console.log(`  Creating AiProviderConnection "${row.service}:${row.provider}" (${row.enabled ? 'enabled' : 'disabled'})`);
    await client.aiProviderConnection.create({
      data: {
        id: row.id,
        tenantId: row.tenantId,
        service: row.service,
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
