/**
 * Config-plane core seed invariants
 *
 * Static assertions over the EXPORTED seed data (no live DB), following the
 * conventions of `ai-model-consolidation-seed.test.ts` in this directory.
 *
 * The load-bearing rule these tests encode is the SILENT-CHANGE
 * guard: with the shipped seeds, every request path must resolve exactly
 * today's effective values. Concretely —
 *
 *   1. Every seeded `AiProviderConnection` is `enabled: false` and carries NO
 *      key material, so `resolveConnection` falls through to the service env
 *      fallback exactly as it does today.
 *   2. `AiRuntimeProfile` seeds are EMPTY. Absence of a profile row means "no
 *      opinion" — the injection cascade falls through to the service's own
 *      pydantic/env default, so forwarded requests stay byte-identical.
 *
 * Plus the allow-list drift guard (§5 test 19): both models must be
 * tenant-scoped, SYSTEM-shared for reads, and soft-deleting.
 */

import { describe, it, expect } from 'vitest';

import { MODELS_WITHOUT_SOFT_DELETE } from '../../../../client';
import { SYSTEM_SHARED_READ_MODELS, TENANT_SCOPED_MODELS } from '../../../../extensions/tenant-scope';
import { AI_MODEL_PROVIDERS } from '../ai-models/shared';
import { SYSTEM_TENANT_ID } from '../00-constants';
import { SYSTEM_AI_PROVIDER_CONNECTIONS } from '../17-ai-provider-connection';
import { SYSTEM_AI_RUNTIME_PROFILES } from '../18-ai-runtime-profile';

// =============================================================================
// 1. AiProviderConnection seed shape
// =============================================================================

describe('AiProviderConnection SYSTEM seed rows', () => {
    it('seeds exactly one row per canonical provider', () => {
        const providers = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => c.provider).sort();
        expect(providers).toEqual([...AI_MODEL_PROVIDERS].sort());
        expect(SYSTEM_AI_PROVIDER_CONNECTIONS.length).toBe(AI_MODEL_PROVIDERS.length);
    });

    it('keeps every row on the SYSTEM tenant', () => {
        SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => expect(c.tenantId).toBe(SYSTEM_TENANT_ID));
    });

    it('seeds every connection DISABLED so resolution falls through to env (silent-change guard)', () => {
        SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
            expect(c.enabled, `connection ${c.provider} must seed disabled`).toBe(false);
        });
    });

    it('never seeds key material', () => {
        SYSTEM_AI_PROVIDER_CONNECTIONS.forEach((c) => {
            expect(c.encryptedApiKey ?? null, `connection ${c.provider} must have no ciphertext`).toBeNull();
            expect(c.keyVersion ?? null, `connection ${c.provider} must have no key version`).toBeNull();
        });
    });

    it('marks every seeded endpoint value as a placeholder in metaData', () => {
        SYSTEM_AI_PROVIDER_CONNECTIONS.filter((c) => c.baseUrl || c.region).forEach((c) => {
            expect(c.metaData?.placeholder, `connection ${c.provider} endpoint must be marked placeholder`).toBe(true);
        });
    });

    it('has unique ids and one row per (tenant, provider)', () => {
        const ids = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => c.id);
        const pairs = SYSTEM_AI_PROVIDER_CONNECTIONS.map((c) => `${c.tenantId}::${c.provider}`);
        expect(new Set(ids).size).toBe(ids.length);
        expect(new Set(pairs).size).toBe(pairs.length);
    });
});

// =============================================================================
// 2. AiRuntimeProfile seed shape — deliberately empty
// =============================================================================

describe('AiRuntimeProfile seed', () => {
    it('seeds NO profile rows (absence = env defaults; silent-change guard)', () => {
        expect(SYSTEM_AI_RUNTIME_PROFILES).toEqual([]);
    });
});

// =============================================================================
// 3. Allow-list drift guard (§5 test 19)
// =============================================================================

describe('client extension allow-lists', () => {
    it.each(['AiProviderConnection', 'AiRuntimeProfile'])('registers %s as tenant-scoped', (model) => {
        expect(TENANT_SCOPED_MODELS.has(model)).toBe(true);
    });

    it.each(['AiProviderConnection', 'AiRuntimeProfile'])('registers %s as a SYSTEM-shared read model', (model) => {
        expect(SYSTEM_SHARED_READ_MODELS.has(model)).toBe(true);
    });

    it.each(['AiProviderConnection', 'AiRuntimeProfile'])('keeps %s soft-deleting', (model) => {
        expect(MODELS_WITHOUT_SOFT_DELETE.has(model)).toBe(false);
    });
});
