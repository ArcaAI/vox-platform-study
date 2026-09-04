/**
 * SELF-HOSTED-DEFAULT / MANAGED-ASR-AS-ADD-ON seed invariants
 *
 * Static assertions over the EXPORTED seed rows (no live DB), following the
 * conventions of `tenant-tts-config-seed.test.ts` in this directory.
 *
 * The rule these tests encode is a UNIT-ECONOMICS decision, not a preference.
 * A 20-minute consultation costs the platform ~$0.028 on self-hosted ASR and
 * ~$0.37 on managed ASR (Azure Speech, 278µ/audio-second) — while PRO earns
 * $0.40/consultation. Routing platform-funded traffic to managed ASR therefore
 * takes PRO from ~93% gross margin to ~7%, and negative at a 30-minute average.
 *
 * So: the SYSTEM default is self-hosted, and managed ASR is an ADD-ON reached
 * through tenant BYOK (the tenant funds its own provider; usage is metered but
 * zero-rated, D14) or an explicit tenant-scoped arrangement. The three ways that
 * could silently regress are exactly the three assertions below.
 *
 * TASK-861: the platform default is no longer an `AsrPipeline` row with
 * `isDefault`, and the platform fallback is no longer `TenantSttConfig
 * .fallbackPipelineId` — both seed halves are gone. The default is the
 * SPEECH_TO_TEXT agent the SYSTEM tenant assigns (`25-agents.ts`), and its
 * fallback chain is the agent's own `fallbackModelSlugs`, so the invariants are
 * asserted on the agent's primary model and on every model in that chain.
 *
 * NOTE (deliberately NOT asserted here): that a managed-ASR add-on bills at a
 * premium. It cannot today — `BillingService.prefetchSellRates` resolves SELL
 * rates with `provider: null` by construction, so a provider-keyed SELL row
 * would never be read.
 */

import { describe, it, expect } from 'vitest';

import { DEFAULT_AI_MODELS } from '../06-ai-models';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';
import { PLATFORM_AGENT_ASSIGNMENTS, PLATFORM_AGENT_SPECS } from '../25-agents';
import { AiDeploymentKind } from '../ai-models/shared';
import { SYSTEM_TENANT_ID } from '../00-constants';

/** Provider slugs that bill a third party per audio-second. */
const MANAGED_STT_PROVIDERS = new Set(['azure-speech', 'azure-foundry', 'sarvam', 'openai', 'deepgram', 'assemblyai', 'azure']);

/** A catalogue row is managed if it is a CLOUD deployment or served by a managed vendor. */
const isManagedModel = (model: { deploymentKind: string; provider: string; tags: readonly string[] }) =>
  model.deploymentKind === AiDeploymentKind.CLOUD || MANAGED_STT_PROVIDERS.has(model.provider) || model.tags.includes('cloud');

const modelBySlug = (slug: string) => DEFAULT_AI_MODELS.find((model) => model.slug === slug);

describe('managed ASR is an add-on, never the platform-funded default', () => {
  describe('the platform-default ASR agent is self-hosted', () => {
    const assignments = PLATFORM_AGENT_ASSIGNMENTS.filter((assignment) => assignment.task === 'SPEECH_TO_TEXT');
    const agent = PLATFORM_AGENT_SPECS.find((spec) => spec.slug === assignments[0]?.agentSlug);

    it('SYSTEM assigns exactly one SPEECH_TO_TEXT agent, and it is PUBLISHED + active', () => {
      expect(assignments, 'SYSTEM must assign exactly one platform-default ASR agent').toHaveLength(1);
      expect(agent, `assigned agent ${assignments[0]?.agentSlug} must be a seeded SYSTEM spec`).toBeDefined();
      expect(agent!.tenantId).toBe(SYSTEM_TENANT_ID);
      expect(agent!.task).toBe('SPEECH_TO_TEXT');
      expect(agent!.status).toBe('PUBLISHED');
      expect(agent!.isActive).toBe(true);
    });

    it('its primary model is a self-hosted catalogue row, not a managed vendor', () => {
      const model = modelBySlug(agent!.modelSlug);
      expect(model, `primary model ${agent!.modelSlug} must be in the catalogue`).toBeDefined();
      expect(isManagedModel(model!), `default ASR model ${model!.slug} must be self-hosted`).toBe(false);
    });

    it('its fallback chain never reaches a managed vendor on platform credentials', () => {
      // Replaces the retired "SYSTEM TenantSttConfig.fallbackPipelineId is NULL"
      // invariant: a cloud model here would make managed ASR every tenant's fallback.
      expect(agent!.fallbackModelSlugs.length).toBeGreaterThan(0);
      for (const slug of agent!.fallbackModelSlugs) {
        const model = modelBySlug(slug);
        expect(model, `fallback model ${slug} must be in the catalogue`).toBeDefined();
        expect(isManagedModel(model!), `fallback model ${slug} must be self-hosted`).toBe(false);
      }
    });
  });

  describe('no platform-funded managed ASR credential', () => {
    const sttConnections = SYSTEM_AI_PROVIDER_CONNECTIONS.filter((connection) => connection.service === 'stt');

    it('seeds at least one managed STT connection (the add-on is offerable)', () => {
      const managed = sttConnections.filter((connection) => MANAGED_STT_PROVIDERS.has(connection.provider));
      expect(managed.length).toBeGreaterThan(0);
    });

    it('leaves every managed STT connection DISABLED and key-less on the SYSTEM tenant', () => {
      for (const connection of sttConnections) {
        if (!MANAGED_STT_PROVIDERS.has(connection.provider)) continue;

        expect(connection.tenantId, `${connection.provider} must be SYSTEM-owned`).toBe(SYSTEM_TENANT_ID);
        // Enabling one of these WITH a platform key is what turns managed ASR
        // from a tenant-funded add-on into a platform-funded default.
        expect(connection.enabled, `SYSTEM ${connection.provider} must ship disabled`).toBe(false);
        expect(connection.encryptedApiKey, `SYSTEM ${connection.provider} must ship without a platform key`).toBeNull();
      }
    });
  });
});
