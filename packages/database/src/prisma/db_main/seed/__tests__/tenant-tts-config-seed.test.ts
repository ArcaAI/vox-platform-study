/**
 * SYSTEM TenantTtsConfig default seed invariants (TASK-577, finding F1)
 *
 * Static assertions over the EXPORTED seed row (no live DB), following the
 * conventions of `config-plane-seed.test.ts` / `ai-model-consolidation-seed.test.ts`
 * in this directory. The database test suite is static-only (`vitest run`, no
 * DB); the live row-existence + idempotency proof is captured via a `psql`
 * SELECT after a test-DB reseed (see the ticket README, Phase D).
 *
 * The load-bearing rule these tests encode is BUILT-IN-FIRST (OD-2): the Day-1
 * TTS default is DB-sourced from the SYSTEM tenant and points at a platform-run
 * built-in local engine (kokoro / indic_parler) — never a cloud vendor (azure /
 * sarvam) implicitly. This is the row that makes `getEffective` resolve a
 * concrete built-in chain for a tenant with no config of its own, so the router
 * never has to fall back to a code/env vendor default (which this ticket
 * removes; the router now fails closed).
 */

import { describe, it, expect } from 'vitest';

import { PLATFORM_TTS_PROVIDER_UNIVERSE, SYSTEM_TENANT_TTS_CONFIG } from '../19-tenant-tts-config';
import { SYSTEM_TENANT_ID, SYSTEM_USER_ID } from '../00-constants';

const BUILT_IN_PROVIDERS = new Set(['kokoro', 'indic_parler', 'indic_f5']);
const CLOUD_PROVIDERS = new Set(['azure', 'sarvam']);

describe('SYSTEM TenantTtsConfig default row', () => {
  it('lives on the reserved SYSTEM tenant', () => {
    expect(SYSTEM_TENANT_TTS_CONFIG.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('has a stable id and is created by the system user', () => {
    expect(SYSTEM_TENANT_TTS_CONFIG.id).toMatch(/^[0-9a-fA-F-]{36}$/);
    expect(SYSTEM_TENANT_TTS_CONFIG.createdBy).toBe(SYSTEM_USER_ID);
  });

  it('defaults English routing to the built-in Kokoro engine (OD-2)', () => {
    expect(SYSTEM_TENANT_TTS_CONFIG.routingEn).toEqual(['kokoro']);
  });

  it('defaults Malayalam routing to the built-in Indic Parler engine (OD-2)', () => {
    expect(SYSTEM_TENANT_TTS_CONFIG.routingMl).toEqual(['indic_parler']);
  });

  it('never puts a cloud vendor first in a default routing chain', () => {
    expect(CLOUD_PROVIDERS.has(SYSTEM_TENANT_TTS_CONFIG.routingEn[0]!)).toBe(false);
    expect(CLOUD_PROVIDERS.has(SYSTEM_TENANT_TTS_CONFIG.routingMl[0]!)).toBe(false);
    expect(BUILT_IN_PROVIDERS.has(SYSTEM_TENANT_TTS_CONFIG.routingEn[0]!)).toBe(true);
    expect(BUILT_IN_PROVIDERS.has(SYSTEM_TENANT_TTS_CONFIG.routingMl[0]!)).toBe(true);
  });

  it('whitelists a non-empty allowedProviders that includes the built-in default engines', () => {
    expect(SYSTEM_TENANT_TTS_CONFIG.allowedProviders.length).toBeGreaterThan(0);
    expect(SYSTEM_TENANT_TTS_CONFIG.allowedProviders).toContain('kokoro');
    expect(SYSTEM_TENANT_TTS_CONFIG.allowedProviders).toContain('indic_parler');
  });

  it('only references providers from the platform provider universe', () => {
    const universe = new Set<string>(PLATFORM_TTS_PROVIDER_UNIVERSE);
    for (const provider of [
      ...SYSTEM_TENANT_TTS_CONFIG.routingEn,
      ...SYSTEM_TENANT_TTS_CONFIG.routingMl,
      ...SYSTEM_TENANT_TTS_CONFIG.allowedProviders,
    ]) {
      expect(universe.has(provider), `provider ${provider} must be in the universe`).toBe(true);
    }
  });
});
