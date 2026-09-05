/**
 * ONE spelling names a cloud ASR vendor on the `stt` plane.
 *
 * TASK-880 DEFERRED-1, closed by TASK-888. Two vocabularies describe the same
 * vendor and they CANNOT import each other (`@arcaai/applications` depends on
 * `@arcaai/database`, so the seed cannot import the governance list without a
 * package cycle — the same shape as `ai-model-providers.contract.test.ts`):
 *
 *   - `AiModel.provider` on the seeded catalogue rows (`AI_MODEL_PROVIDERS`), and
 *   - `CLOUD_BYO_PROVIDERS.stt`, the governance list `AsrAgentResolverService`
 *     gates BYO credential resolution on.
 *
 * They disagreed. Both cloud ASR rows declared the LLM-plane spelling `azure`
 * while the seeded `AiProviderConnection` row, the four `apps/stt` loaders and
 * `CLOUD_BYO_PROVIDERS.stt` all said `azure-speech` / `azure-foundry`. The
 * consequence was silent and one-directional: `resolveCredentials` reads
 * `spec.models.asr.provider` off the resolved agent, asks
 * `isCloudByoProvider('stt', 'azure')` — false — and returns NO credential, so
 * a streaming session on an Azure ASR agent ran with an empty
 * `provider_overrides` map and the loader failed closed. Batch was unaffected
 * because `resolveProviderOverrides` iterates `CLOUD_BYO_PROVIDERS.stt` itself
 * and never reads the model's provider.
 *
 * The unit tests could not catch it: they mock the resolved agent off
 * `resolved-asr-spec.fixture.json`, which already carried the correct spelling.
 * Hence this test — it reads the REAL seed rows.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AsrAgentResolverService, CLOUD_BYO_PROVIDERS, isCloudByoProvider } from '@arcaai/applications';
import type { ResolvedAgent } from '@arcaai/applications';
import { DEFAULT_AI_MODELS } from '../../packages/database/src/prisma/db_main/seed/06-ai-models';

const fixture = JSON.parse(readFileSync(join(__dirname, 'resolved-asr-spec.fixture.json'), 'utf-8')) as {
  cloudWithAgentFallback: { input: { agent: ResolvedAgent } };
};

const TENANT = '50000000-0000-0000-0000-000000000000';

/** Every SYSTEM catalogue row an ASR agent can bind that is served by a vendor, not by us. */
const cloudAsrRows = DEFAULT_AI_MODELS.filter((row) => row.taskType === 'AUTOMATIC_SPEECH_RECOGNITION' && row.deploymentKind === 'CLOUD');

describe('cloud ASR catalogue rows and the stt BYO vocabulary agree on the vendor name', () => {
  it('finds the seeded cloud ASR rows at all (a green suite over an empty list proves nothing)', () => {
    expect(cloudAsrRows.map((row) => row.slug).sort()).toEqual(['azure-speech-stt', 'mai-transcribe-1.5', 'openai-gpt4o-transcribe', 'sarvam-saaras-v4']);
  });

  it('declares a provider that `AsrAgentResolverService` will treat as tenant-BYO eligible', () => {
    for (const row of cloudAsrRows) {
      expect(isCloudByoProvider('stt', String(row.provider)), `${row.slug}.provider=${row.provider} is not in CLOUD_BYO_PROVIDERS.stt`).toBe(true);
    }
  });

  it('keeps `azure` as the LLM-plane spelling — the two planes are separate credentials, not one', () => {
    // Deliberate, not an oversight: an Azure OpenAI resource and an Azure Speech
    // resource are different vendors' worth of credential and residency posture.
    expect(CLOUD_BYO_PROVIDERS.llm).toContain('azure');
    expect(CLOUD_BYO_PROVIDERS.stt).not.toContain('azure');
  });
});

describe('a streaming session on an Azure ASR agent resolves a credential', () => {
  const seededAzureProvider = String(cloudAsrRows.find((row) => row.slug === 'azure-speech-stt')!.provider);

  /** The fixture's cloud agent, with its ASR model re-stamped with the value the SEED actually writes. */
  const agentOnTheSeededProvider = (): ResolvedAgent => {
    const agent = structuredClone(fixture.cloudWithAgentFallback.input.agent) as ResolvedAgent;
    for (const model of agent.models) {
      if (model.provider === 'azure-speech') model.provider = seededAzureProvider;
    }
    return agent;
  };

  it('folds the SYSTEM (or tenant) credential onto provider_overrides, keyed by the seeded provider name', async () => {
    const agents = { resolve: vi.fn().mockResolvedValueOnce(agentOnTheSeededProvider()).mockResolvedValueOnce(null) };
    const credentials = {
      resolve: vi.fn().mockResolvedValue({ override: { api_key: 'k-azure', funding: 'platform', region: 'eastus' }, fundingTier: 'platform', connectionId: 'c1' }),
    };
    const service = new AsrAgentResolverService(agents as never, credentials as never);

    const result = await service.resolve({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' });

    expect(agents.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, agentSlug: 'clinic-azure-transcription' }));
    expect(credentials.resolve).toHaveBeenCalledWith('stt', seededAzureProvider, TENANT);
    expect(result.providerOverrides).toEqual({ [seededAzureProvider]: { api_key: 'k-azure', funding: 'platform', region: 'eastus' } });
    expect(result.fundingTier).toBe('platform');
    // The credential never rides on the spec itself — it goes on the wire beside it.
    expect(JSON.stringify(result.spec)).not.toContain('k-azure');
  });
});
