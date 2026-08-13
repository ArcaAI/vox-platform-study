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
 * NOTE (deliberately NOT asserted here): that a managed-ASR add-on bills at a
 * premium. It cannot today — `BillingService.prefetchSellRates` resolves SELL
 * rates with `provider: null` by construction, so a provider-keyed SELL row
 * would never be read.
 */

import { describe, it, expect } from 'vitest';

import { CUSTOMER_TENANT_ASR_PIPELINES, DEFAULT_ASR_PIPELINES, GLOBAL_TENANT_ASR_PIPELINES, SYSTEM_TENANT_STT_CONFIG } from '../06-stt';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';
import { SYSTEM_TENANT_ID } from '../00-constants';

/** Provider slugs that bill a third party per audio-second. */
const MANAGED_STT_PROVIDERS = new Set(['azure-speech', 'azure-foundry', 'sarvam', 'openai', 'deepgram', 'assemblyai']);

/** A pipeline is managed if it is tagged cloud or carries a managed vendor tag. */
const isManagedPipeline = (tags: readonly string[]) => tags.some((tag) => tag === 'cloud' || MANAGED_STT_PROVIDERS.has(tag));

describe('managed ASR is an add-on, never the platform-funded default', () => {
  describe('the default ASR pipeline is self-hosted', () => {
    for (const [label, pipelines] of [
      ['SYSTEM', DEFAULT_ASR_PIPELINES],
      ['customer-tenant', CUSTOMER_TENANT_ASR_PIPELINES],
      ['global-tenant', GLOBAL_TENANT_ASR_PIPELINES],
    ] as const) {
      it(`${label}: exactly one default, and it is not a managed/cloud pipeline`, () => {
        const defaults = pipelines.filter((pipeline) => pipeline.isDefault);
        expect(defaults, `${label} must declare exactly one default pipeline`).toHaveLength(1);

        const [only] = defaults;
        expect(isManagedPipeline(only!.tags ?? []), `default pipeline ${only!.slug} must be self-hosted`).toBe(false);
      });
    }
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

  describe('no platform-default fallback', () => {
    it('SYSTEM TenantSttConfig leaves fallbackPipelineId NULL', () => {
      expect(SYSTEM_TENANT_STT_CONFIG.tenantId).toBe(SYSTEM_TENANT_ID);
      // A cloud pipeline here would make managed ASR every tenant's fallback.
      expect(SYSTEM_TENANT_STT_CONFIG.fallbackPipelineId).toBeNull();
    });
  });
});
