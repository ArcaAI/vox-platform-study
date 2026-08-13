import { describe, it, expect } from 'vitest';
import { DEFAULT_API_KEYS } from '../prisma/db_main/seed/02-apikey';
import { SEED_API_KEY_IDS } from '../prisma/db_main/seed/00-constants';

/**
 * The seeded SDK keys must be able to exercise the day-1 Node SDK surface.
 *
 * Background: the summarization routes now declare `@RequiredScopes(...)`, which the
 * `UnifiedAuthGuard` enforces for API-key callers. Before that, NO route declared scopes, so a
 * seeded key's scope list was decorative and nobody noticed that none of them carried
 * `consultation:report:write`. Turning enforcement on made every seeded SDK key 403 on summary
 * and pre-summary generation — the SDK's flagship day-1 capability, and the first thing a local
 * developer tries.
 *
 * This guards the pairing: if a route's required scope changes, or a seeded key's scope list is
 * trimmed, this fails loudly instead of surfacing as a confusing 403 in someone's dev loop.
 */

/**
 * The scopes the day-1 SDK surface needs, mirroring the `@RequiredScopes(...)` declared on:
 *  - POST /api/smr/api/v1/{presummary,summary/sync}          → consultation:report:write
 *  - POST /consultations/:id/summary[/pre-summary][/async]   → consultation:report:write
 *  - GET  /consultations/:id/summary{,/latest,/pre-summary/latest} → consultation:report:read
 *  - GET/POST /consultations/jobs/:jobId{,/cancel,/stream}   → consultation:session:read
 *
 * Keep in sync with those decorators. `api-key-scope-audit.ts` guards the routes' half.
 */
const DAY_ONE_SDK_SCOPES = ['consultation:report:write', 'consultation:report:read', 'consultation:session:read'] as const;

/**
 * The seeded keys a developer or integration test is expected to drive the SDK with.
 * Named explicitly rather than inferred — "which keys should work" is a deliberate choice,
 * not something to derive from the data being asserted.
 */
const SDK_CAPABLE_KEY_IDS = [
  SEED_API_KEY_IDS.SDK_DOCTOR,
  SEED_API_KEY_IDS.SDK_DOCTOR2,
  SEED_API_KEY_IDS.SDK_ARCAAI,
  SEED_API_KEY_IDS.SDK_SURGERY,
] as const;

describe('seeded API keys — day-1 Node SDK scope coverage', () => {
  for (const keyId of SDK_CAPABLE_KEY_IDS) {
    const seeded = DEFAULT_API_KEYS.find((k) => k.id === keyId);

    it(`"${seeded?.keyName ?? keyId}" carries every scope the day-1 SDK surface requires`, () => {
      expect(seeded, `no seeded key with id ${keyId}`).toBeDefined();

      const scopes = seeded!.scopes as string[];
      const missing = DAY_ONE_SDK_SCOPES.filter((required) => !scopes.includes(required));

      expect(missing, `missing scope(s) — this key will 403 on the SDK's summarization flow`).toEqual([]);
    });
  }

  it('at least one seeded key exercises a category wildcard, so wildcard matching stays covered', () => {
    // `INTEGRATION_ARCAAI` holds `consultation:*`. That form silently granted NOTHING until
    // `ApiKeyService.hasScope` learned to match `<category>:*`, so this asserts the fixture that
    // depends on it still exists — the wildcard path must not become untested in practice.
    const wildcardKeys = DEFAULT_API_KEYS.filter((k) => (k.scopes as string[]).some((s) => s.endsWith(':*')));

    expect(wildcardKeys.length).toBeGreaterThan(0);
  });
});
