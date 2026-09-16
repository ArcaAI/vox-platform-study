import { describe, it, expect } from 'vitest';
import { API_KEY_SCOPE_PRESETS } from '@arcaai/types';
import { DEFAULT_API_KEYS, SDK_DAY_ONE_SCOPES } from '../prisma/db_main/seed/02-apikey';
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
 *  - POST /api/smr/api/v1/{presummary,summary/sync} → consultation:report:write
 *  - POST /consultations/:id/summary[/pre-summary][/async] → consultation:report:write
 *  - GET /consultations/:id/summary{,/latest,/pre-summary/latest} → consultation:report:read
 *  - GET/POST /consultations/jobs/:jobId{,/cancel,/stream} → consultation:session:read
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
  // The compat key spreads `SDK_DAY_ONE_SCOPES` exactly like its four
  // siblings, but was omitted from this list, so nothing pinned it: trimming
  // its scopes would have gone unnoticed until a compat app 403'd. It is the
  // key `<ArcaCompatProvider>` is driven with, so it is at least as load-bearing
  // as the four above.
  SEED_API_KEY_IDS.SDK_COMPAT_ARCAAI,
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

/**
 * no seeded key may carry a RESERVED scope.
 *
 * makes `/api/v1/admin/*` a JWT-only plane: all 65 admin controllers
 * carry `@ForbidApiKey()`, which `UnifiedAuthGuard` checks BEFORE the scope
 * check, so every `admin:*` string is inert whatever a key holds. The
 * `webhook:*` family goes with them — its only consumer is `WebhookController`
 * at `admin/webhooks`. Those 59 strings are marked `reserved: true` in
 * `apikey-scopes.registry.ts`: refused at GRANT time and dropped from the
 * advertised catalog.
 *
 * A seeded key carrying one is therefore doubly wrong — dead on arrival at
 * request time, AND not reproducible through the console a developer would use
 * to mint an equivalent key. Before this ticket, `SDK_ARCAAI` carried three
 * (`admin:user:read`, `admin:apikey:read`, `admin:tenant:read`) and
 * `WEBHOOK_ADMIN` carried two.
 *
 * The list is restated here rather than imported: `packages/database` does not
 * depend on `@arcaai/applications` (the edge runs the other way), so this is a
 * deliberate mirror. It is a PREFIX check, so it cannot go stale as new
 * `admin:<area>` scopes are added.
 */
const RESERVED_SCOPE_PREFIXES = ['admin:', 'webhook:'] as const;

describe('seeded API keys — reserved scopes (policy A2)', () => {
  for (const key of DEFAULT_API_KEYS) {
    it(`"${key.keyName}" carries no reserved scope`, () => {
      const offending = (key.scopes as string[]).filter((scope) => RESERVED_SCOPE_PREFIXES.some((prefix) => scope.startsWith(prefix)));

      expect(offending, `reserved scope(s) on a seeded key — inert at request time and refused at grant time`).toEqual([]);
    });
  }

  it("the platform SERVICE_ACCOUNT key is scoped to its one purpose, not '*'", () => {
    // BUG-013: this row is the STT worker's gateway credential (`API_GATEWAY_KEY`
    // must be its RAW value). The worker calls only `/internal/stt/*`, which
    // declares `@RequiredScopes('internal:stt:worker')`. `'*'` granted every
    // non-admin scope on the platform to a key bound to a CUSTOMER tenant.
    const serviceAccount = DEFAULT_API_KEYS.find((k) => k.id === SEED_API_KEY_IDS.SERVICE_ACCOUNT);

    expect(serviceAccount).toBeDefined();
    expect(serviceAccount!.scopes).toEqual(['internal:stt:worker']);
  });
});

/**
 * the business-plane reads the SDK actually performs.
 *
 * gave nine previously-undeclared controllers a scope. Several sit
 * directly on the day-1 SDK path, so a key minted before that change now 403s
 * on them. Each scope below is pinned to the SDK call that needs it, so
 * trimming one fails here instead of surfacing as a confusing 403 in a
 * developer's dev loop.
 */
const SDK_BUSINESS_PLANE_SCOPES: ReadonlyArray<readonly [scope: string, why: string]> = [
  ['prompt:template:read', 'GET /prompt-templates/available — the clinician Pre-Summary/Summary template selector'],
  ['stt:model:read', 'GET /audio/pipelines — the ASR pipeline catalog'],
  ['tenant:context-schema:read', 'GET /tenant/me/context-schema — without it an integrator cannot build a valid context payload'],
  ['tenant:profile:read', 'GET /tenant/me, GET /tenant/me/config'],
  ['tenant:account:read', 'GET /entitlements/me'],
  ['user:settings:read', 'GET /user/me/settings'],
  ['user:settings:write', 'PATCH /user/me/settings'],
  ['user:profile:read', 'GET /user/me/departments, POST /rbac/check'],
  ['platform:changelog:read', "GET /changelog, /changelog/unseen — the What's New dialog"],
  ['tts:speech:write', 'POST /speech/synthesize'],
  ['tts:voice:read', 'GET /speech/voices'],
  ['dna-writing-style:ingest', 'POST /dna-writing-styles/ingest — hope.dnaWritingStyle.ingest / useDnaWritingStyle()'],
  ['agent:definition:read', 'hope.agents.list / vox-codegen --api-key --agents — the types-codegen preset (D-6)'],
  ['workflow:definition:read', 'hope.workflows.list / vox-codegen --api-key --workflows — the types-codegen preset (D-6)'],
];

describe('seeded SDK keys —  business-plane coverage', () => {
  for (const [scope, why] of SDK_BUSINESS_PLANE_SCOPES) {
    it(`the shared SDK scope set carries "${scope}"`, () => {
      expect(SDK_DAY_ONE_SCOPES as readonly string[], why).toContain(scope);
    });
  }

  for (const keyId of SDK_CAPABLE_KEY_IDS) {
    const seeded = DEFAULT_API_KEYS.find((k) => k.id === keyId);

    it(`"${seeded?.keyName ?? keyId}" uses the shared SDK scope set verbatim`, () => {
      // Declared once, not copy-pasted per key: five keys previously carried
      // five hand-maintained copies of the same nine strings, which is how
      // `SDK_ARCAAI` drifted into carrying three admin scopes none of the
      // others had.
      expect(seeded!.scopes).toEqual([...SDK_DAY_ONE_SCOPES]);
    });
  }
});

/**
 * The COMPAT surface — `@arcaai/vox/compat` (SDK compat) and the frozen v1 wire
 * contract (API compat) — for the two capabilities a migrating v1 app needs on
 * day one: TRANSCRIPTION and SUMMARIZATION.
 *
 * Distinct from `DAY_ONE_SDK_SCOPES` above, which only covers the summarization
 * half. The STT strings below were unpinned by anything in this file, yet every
 * compat transcription path dies without them:
 *
 *   - `stt:stream:write` → POST /api/stt/{start_session,switch,stop_session}
 *                                 (`SttCompatController`, class-level
 *                                 `@RequiredScopes`) — the frozen v1 session
 *                                 lifecycle the compat audio socket `/stt` rides on.
 *   - `stt:transcription:write` → POST /audio/transcription-jobs/stream/session
 *                                 (+ /refresh-ticket, /switch-to-{primary,fallback}),
 *                                 which mints the `stt_session:<id>` ticket for
 *                                 `/ws/stt/stream`, AND the batch job routes
 *                                 (`POST /audio/transcription-jobs`, `/{id}`).
 *   - `stt:transcription:read` → transcription result reads.
 *   - `consultation:report:write` → POST /api/smr/api/v1/{summary/sync,presummary}
 *                                 (`TextCompatController`) — the API-compat
 *                                 summarization pair `useText()` calls.
 *
 * `stt:model:read` (GET /audio/pipelines) is already pinned by the
 * business-plane block above; the compat `PipelinePicker` depends on it too.
 */
const COMPAT_SURFACE_SCOPES: ReadonlyArray<readonly [scope: string, why: string]> = [
  ['stt:stream:write', 'POST /api/stt/{start_session,switch,stop_session} — the frozen v1 STT session lifecycle'],
  ['stt:transcription:write', 'POST /audio/transcription-jobs/stream/session (live ticket mint) and the batch job routes'],
  ['stt:transcription:read', 'transcription result reads'],
  ['consultation:report:write', 'POST /api/smr/api/v1/{summary/sync,presummary} — v1-compat summarization'],
];

describe('seeded SDK keys — compat surface (transcription + summarization)', () => {
  for (const [scope, why] of COMPAT_SURFACE_SCOPES) {
    it(`the shared SDK scope set carries "${scope}"`, () => {
      expect(SDK_DAY_ONE_SCOPES as readonly string[], why).toContain(scope);
    });
  }

  it('the ArcaAI compat key carries every compat-surface scope', () => {
    const seeded = DEFAULT_API_KEYS.find((k) => k.id === SEED_API_KEY_IDS.SDK_COMPAT_ARCAAI);

    expect(seeded, 'no seeded key with id SDK_COMPAT_ARCAAI').toBeDefined();
    const scopes = seeded!.scopes as string[];
    const missing = COMPAT_SURFACE_SCOPES.map(([scope]) => scope).filter((required) => !scopes.includes(required));

    expect(missing, 'missing scope(s) — the compat app will 403 on transcription or summarization').toEqual([]);
  });

  it('the ArcaAI compat key is ACTIVE, never-expiring, and bound to a user whose ability can be evaluated', () => {
    const seeded = DEFAULT_API_KEYS.find((k) => k.id === SEED_API_KEY_IDS.SDK_COMPAT_ARCAAI);

    expect(seeded).toBeDefined();
    // `UnifiedAuthGuard` evaluates a route's `@Authorize()` permissions against
    // the key's BOUND USER and refuses outright when there is none — so an
    // unbound key cannot reach `POST /consultations/open` (`create:Consultation`).
    expect(seeded!.userId, 'an unbound key cannot satisfy any CASL-gated route').toBeTruthy();
    expect(seeded!.keyStatus).toBe('ACTIVE');
    expect('expiresAt' in seeded!, 'a seeded dev fixture must not expire out from under a developer').toBe(false);
  });
});

/**
 * D-6 — `SDK_DAY_ONE_SCOPES` is derived from the `@arcaai/types` presets rather than
 * hand-duplicated, so a preset change is reflected here without a second edit.
 *
 * `webhook:event:read` / `webhook:event:write` are DELIBERATELY excluded even though an earlier
 * draft of this ticket's plan named them alongside `platform:changelog:read` and
 * `tenant:account:read`: both are `reserved: true` in `apikey-scopes.registry.ts` (policy A2 —
 * `/admin/*` is JWT-only, `WebhookController` lives at `admin/webhooks`), so seeding them would
 * both fail the "reserved scopes (policy A2)" describe block above and grant a permanently inert
 * scope. This is a recorded deviation from the pinned contract, not an oversight — see this
 * ticket's README for the flagged conflict.
 */
describe('SDK_DAY_ONE_SCOPES — derived from @arcaai/types presets (D-6)', () => {
  it('carries every scope of the consultation-app preset', () => {
    const preset = API_KEY_SCOPE_PRESETS.find((p) => p.key === 'consultation-app');
    expect(preset).toBeDefined();
    for (const scope of preset!.scopes) {
      expect(SDK_DAY_ONE_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it('carries every scope of the types-codegen preset', () => {
    const preset = API_KEY_SCOPE_PRESETS.find((p) => p.key === 'types-codegen');
    expect(preset).toBeDefined();
    for (const scope of preset!.scopes) {
      expect(SDK_DAY_ONE_SCOPES as readonly string[]).toContain(scope);
    }
  });

  it('has no duplicate entries', () => {
    expect(new Set(SDK_DAY_ONE_SCOPES).size).toBe(SDK_DAY_ONE_SCOPES.length);
  });

  it('does NOT carry the reserved webhook:event scopes (recorded deviation from the pinned contract)', () => {
    expect(SDK_DAY_ONE_SCOPES as readonly string[]).not.toContain('webhook:event:read');
    expect(SDK_DAY_ONE_SCOPES as readonly string[]).not.toContain('webhook:event:write');
  });
});
