import { createHash, createHmac } from 'crypto';
import type { CorePrismaClient } from '../../../client';
import { getNodeEnv, type Environment } from '../../../env';
import { ApiKeyStatus, ApiKeyType } from '../../../generated/core-prisma-client/client.js';
import { SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS, SEED_API_KEY_IDS, SEED_API_KEY_RAW, SEED_USER_IDS } from './00-constants';
import { resolveApiKeyPepper } from './api-key-pepper';
import { isPhaseEnabled, type SeedMode } from './seed-mode';

/** This file's phase stem, as `SEED_PHASES_EXCLUDED_FROM_SAFE` spells it. */
const API_KEY_SEED_PHASE = '02-apikey';

/**
 * Dev/test gate predicate (single source of truth).
 *
 * The demo API keys below embed raw secrets (from 00-constants), ACTIVE status
 * and broad scopes. They are LOCAL DEV fixtures only and must never be seeded
 * in production/staging. This predicate is reused by the seed orchestrator
 * (`SEED_DEMO_DATA` in index.ts) and by the defence-in-depth guard inside
 * `seedApiKey`, so the gate and the guard can never disagree.
 */
export function shouldSeedApiKeys(env: Environment = getNodeEnv()): boolean {
  return env === 'development' || env === 'test';
}

/**
 * lane E — explain an API-key seeding skip by the gate that ACTUALLY
 * closed.
 *
 * Demo API-key seeding is gated twice and independently: the seed MODE must
 * include the `02-apikey` phase, AND `NODE_ENV` must be development/test. The
 * skip warning used to report only the second, so `RUN_SEED=safe` with
 * `NODE_ENV=development` printed "NODE_ENV is not development/test" — a false
 * statement that sends an operator to fix the one thing that was already
 * correct.
 *
 * Lives here, beside `shouldSeedApiKeys`, so neither half of the predicate is
 * transcribed at the call site and the two can never drift apart.
 *
 * @throws when neither gate is closed — a caller asking why a skip happened
 *   that did not happen is a bug, and a plausible sentence would conceal it.
 */
export function describeApiKeySeedingSkip(mode: SeedMode, env: Environment = getNodeEnv()): string {
  const reasons: string[] = [];
  if (!isPhaseEnabled(API_KEY_SEED_PHASE, mode)) {
    reasons.push(`the "${API_KEY_SEED_PHASE}" phase is excluded from RUN_SEED="${mode}"`);
  }
  if (!shouldSeedApiKeys(env)) {
    reasons.push(`NODE_ENV="${env}" is not development/test`);
  }
  if (reasons.length === 0) {
    throw new Error(`API-key seeding is not skipped for mode="${mode}" and NODE_ENV="${env}"; there is no reason to describe.`);
  }
  return reasons.join(' and ');
}

/**
 * Build a non-secret, masked preview of a raw key for
 * confirmation logging. Exposes at most the first 4 characters (the shared,
 * non-sensitive `hope` prefix) and masks the remainder, e.g. `hope****`.
 */
export function maskSecret(rawKey: string): string {
  return `${rawKey.slice(0, 4)}****`;
}

/**
 * Hash an API key — HMAC-SHA256 when a pepper is provided, plain SHA-256
 * otherwise. This must match `ApiKeyService.hashKey`. The pepper
 * is resolved once per seed run via `resolveApiKeyPepper` (env first, then
 * Vault KV when SECRETS_PROVIDER=vault) so seeded hashes always match what
 * the running API computes at validation time.
 */
function hashApiKey(rawKey: string, pepper?: string): string {
  if (pepper) {
    return createHmac('sha256', pepper).update(rawKey).digest('hex');
  }
  return createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Extract checksum from key (last segment after underscore)
 */
function extractChecksum(rawKey: string): string | null {
  const parts = rawKey.split('_');
  return parts.length > 0 ? parts[parts.length - 1]! : null;
}

/**
 * Extract prefix from key (first 12 characters)
 */
function extractPrefix(rawKey: string): string {
  return rawKey.substring(0, 12);
}

/**
 * the scope set a seeded SDK key needs to drive the day-1 SDK
 * surface, declared ONCE instead of copy-pasted per key.
 *
 * Every entry is derived from a `@RequiredScopes(...)` a route the browser SDK
 * (`@arcaai/vox`) or the Node SDK (`@arcaai/vox-node`) actually calls — not
 * from what "looks reasonable". The paths were read off the two SDK packages;
 * the scopes off the controllers that serve them:
 *
 * | SDK call | Controller | Scope |
 * |-----------------------------------|-------------------------------------|-------|
 * | consultation + summarization | consultation / text-compat | `consultation:*` (4) |
 * | live + batch transcription | transcription-job / stt ws | `stt:*` (3) |
 * | `GET /audio/pipelines` | `AudioPipelinePublicController` | `stt:model:read` |
 * | `POST /speech/synthesize`, voices | TTS proxy | `tts:speech:write`, `tts:voice:read` |
 * | `GET /prompt-templates/available` | `PromptTemplateController` | `prompt:template:read` |
 * | `GET /tenant/me`, `/tenant/me/config` | `MyTenantController` | `tenant:profile:read` |
 * | `GET /tenant/me/context-schema` | `MyTenantContextSchemaController` | `tenant:context-schema:read` |
 * | `GET /entitlements/me` | `MyEntitlementsController` | `tenant:account:read` |
 * | `GET/PATCH /user/me/settings` | `UserSettingsController` | `user:settings:read|write` |
 * | `GET /user/me/preferences` | `UserPreferencesController` | `user:preferences:read|write` |
 * | `GET /user/me/departments`, `/rbac/check` | user/rbac `me` reads | `user:profile:read` |
 * | `GET /changelog`, `/changelog/unseen` | `ChangelogController` | `platform:changelog:read` |
 *
 * NOT included, deliberately:
 * Any `admin:*` or `webhook:*` scope. makes `/api/v1/admin/*` a
 *     JWT-only plane (`@ForbidApiKey()`, checked BEFORE the scope check), and
 * /757 mark all 59 of those strings `reserved: true` — refused at
 *     GRANT time and dropped from the advertised catalog. A seeded key carrying
 *     one would be dead on arrival AND unreproducible through the console.
 *   - `media:file:read`. No route declares it, and `read:Storage` is not an
 * ability any clinical role holds — Decisions.
 * `workflow:*`. The exposure plane ships behind a kill-switch.
 */
export const SDK_DAY_ONE_SCOPES = [
  // Transcription
  'stt:transcription:read',
  'stt:transcription:write',
  'stt:stream:write',
  'stt:model:read',
  // Speech synthesis
  'tts:speech:write',
  'tts:voice:read',
  // Consultation + summarization. `consultation:report:write` is the SDK's
  // flagship day-1 capability (summary / pre-summary generation) — the seeded
  // keys 403'd on it once the summarization routes began declaring scopes,
  // which is why `seed-apikey-sdk-scopes.test.ts` pins it.
  'consultation:session:read',
  'consultation:session:write',
  'consultation:report:read',
  'consultation:report:write',
  // Clinician template selector
  'prompt:template:read',
  // Tenant self-service reads (resolve to the KEY'S tenant, not its user)
  'tenant:profile:read',
  'tenant:context-schema:read',
  'tenant:account:read',
  // User self-service (resolve to the key's BOUND USER)
  'user:profile:read',
  'user:preferences:read',
  'user:preferences:write',
  'user:settings:read',
  'user:settings:write',
  // Release notes / What's New
  'platform:changelog:read',
  // TASK-974 — `hope.dnaWritingStyle.ingest` (`@arcaai/vox-node`) and `useDnaWritingStyle()`
  // (`@arcaai/vox`). It gates the INGEST surface only: submitting writing samples for a
  // clinician, never reading a profile back — `DnaWritingStyleController` keeps its
  // `@ForbidApiKey()` exemption, so a key still cannot reach a clinician's personal model.
  'dna-writing-style:ingest',
] as const;

export const DEFAULT_API_KEYS = [
  {
    id: SEED_API_KEY_IDS.SDK_DOCTOR,
    rawKey: SEED_API_KEY_RAW.SDK_DOCTOR,
    keyName: 'SDK Test API Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for development and testing - linked to doctor user',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    scopes: [...SDK_DAY_ONE_SCOPES],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.SDK_DOCTOR2,
    rawKey: SEED_API_KEY_RAW.SDK_DOCTOR2,
    keyName: 'SDK API Key - Doctor 2',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for doctor2 - for multi-user testing',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    scopes: [...SDK_DAY_ONE_SCOPES],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.WEBHOOK_ADMIN,
    rawKey: SEED_API_KEY_RAW.WEBHOOK_ADMIN,
    keyName: 'Webhook Integration Key',
    keyType: ApiKeyType.WEBHOOK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Webhook API key for tenant admin - receives event notifications',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.TENANT_ADMIN,
    // deliberately EMPTY, not `['webhook:event:read','webhook:event:write']`.
    //
    // `WebhookController` lives at `admin/webhooks`, so policy A2
    // (`/api/v1/admin/*` is JWT-only) makes it unreachable by ANY API key, and
    // both `webhook:*` strings are now `reserved: true` in
    // `apikey-scopes.registry.ts` — refused at grant time, dropped from the
    // advertised catalog. Seeding them would produce a key that cannot be
    // reproduced through the console and 403s on the only surface it names.
    //
    // The row is kept because a WEBHOOK-type key's day-1 purpose is OUTBOUND
    // delivery identity (and `10-audit-log.ts:133` references its id), not
    // inbound reach. `ApiKeyService.hasScope` returns false for an empty array,
    // so this fails CLOSED on every scoped route — which is the honest state.
    // Re-pointing it at a real inbound capability needs an owner decision; see
    // Decisions.
    scopes: [] as string[],
    rateLimit: 500,
  },
  {
    id: SEED_API_KEY_IDS.SERVICE_ACCOUNT,
    rawKey: SEED_API_KEY_RAW.SERVICE_ACCOUNT,
    keyName: 'Service Account Key',
    keyType: ApiKeyType.SERVICE_ACCOUNT,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Service account API key for backend integrations',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.SERVICE_ACCOUNT,
    // narrowed from `['*']` to the one scope this credential is
    // actually for.
    //
    // This row is the STT worker's gateway credential: BUG-013 requires
    // `API_GATEWAY_KEY` to be the RAW value of a registered ACTIVE
    // SERVICE_ACCOUNT `ApiKey` row, and `.env.dev` sets it to exactly this
    // key's raw value. The worker calls ONLY `/internal/stt/*` (verified across
    // `apps/stt/src/stt/core/api_client/gateway.py` — 10 call sites, all under
    // that prefix) plus `/internal/effective-config`, which is `@Public()`.
    // `SttInternalController` declares `@RequiredScopes('internal:stt:worker')`,
    // so the exact scope satisfies it and the wildcard bought nothing the
    // worker needed.
    //
    // What it DID buy: an unrestricted credential — one that satisfies every
    // scope on every non-admin route — bound to a CUSTOMER tenant
    // (`SEED_TENANT_ID`, the Global playground). `'*'` is the single most
    // dangerous string in the registry and is deliberately NOT `reserved`,
    // because it stays legitimate on `/internal/*`; that is a reason to scope
    // it precisely, not to leave it wide.
    //
    // NOTE for /762: three comments in `apps/api/src` still describe
    // this credential as "scopes `['*']`" (`stt-internal.controller.ts` and
    // `apikey-scopes.registry.ts`'s `internal:stt:worker` entry). They remain
    // CORRECT about the outcome — the worker still clears the gate — but the
    // parenthetical is now stale. `apps/api/src` is owned by in this
    // sprint and was not edited here.
    scopes: ['internal:stt:worker'],
    rateLimit: 5000,
  },
  {
    id: SEED_API_KEY_IDS.SDK_ARCAAI,
    rawKey: SEED_API_KEY_RAW.SDK_ARCAAI,
    keyName: 'ArcaAI Tenant SDK Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for ArcaAI tenant admin - multi-tenant testing',
    environment: 'development',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_ADMIN,
    scopes: [...SDK_DAY_ONE_SCOPES],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.REVOKED_DOCTOR,
    rawKey: SEED_API_KEY_RAW.REVOKED_DOCTOR,
    keyName: 'Revoked Test Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.REVOKED,
    description: 'Revoked SDK key for testing key revocation flow',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR,
    scopes: ['stt:transcription:read', 'consultation:session:read'],
    rateLimit: 100,
  },
  {
    id: SEED_API_KEY_IDS.SDK_SURGERY,
    rawKey: SEED_API_KEY_RAW.SDK_SURGERY,
    keyName: 'SDK API Key - Surgery',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for doctor_surgery - surgical workflow testing',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR_SURGERY,
    scopes: [...SDK_DAY_ONE_SCOPES],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.INTEGRATION_ARCAAI,
    rawKey: SEED_API_KEY_RAW.INTEGRATION_ARCAAI,
    keyName: 'ArcaAI Integration Key',
    keyType: ApiKeyType.INTEGRATION,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'Integration API key for ArcaAI tenant - read-only data access',
    environment: 'development',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_ADMIN,
    scopes: ['stt:*', 'consultation:*'],
    rateLimit: 2000,
  },
  {
    id: SEED_API_KEY_IDS.SDK_COMPAT_ARCAAI,
    rawKey: SEED_API_KEY_RAW.SDK_COMPAT_ARCAAI,
    keyName: 'ArcaAI SDK Compat Key',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.ACTIVE,
    description: 'SDK API key for ArcaAI tenant - client-side SDK compat usage',
    environment: 'development',
    tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    userId: SEED_USER_IDS.ARCAAI_ADMIN,
    scopes: [...SDK_DAY_ONE_SCOPES],
    rateLimit: 1000,
  },
  {
    id: SEED_API_KEY_IDS.EXPIRED_DOCTOR2,
    rawKey: SEED_API_KEY_RAW.EXPIRED_DOCTOR2,
    keyName: 'Expired Test Key - Doctor2',
    keyType: ApiKeyType.SDK,
    keyStatus: ApiKeyStatus.EXPIRED,
    description: 'Expired SDK key for testing key expiration flow',
    environment: 'development',
    tenantId: SEED_TENANT_ID,
    userId: SEED_USER_IDS.DOCTOR2,
    scopes: ['stt:transcription:read', 'consultation:session:read'],
    rateLimit: 100,
  },
];

export const seedApiKey = async (client: CorePrismaClient) => {
  // Defence in depth. The orchestrator already gates this
  // step behind `SEED_DEMO_DATA` (dev/test only); refuse to run if invoked
  // directly outside dev/test so the raw-secret fixtures can never reach
  // production/staging even if the gate is bypassed.
  const env = getNodeEnv();
  if (!shouldSeedApiKeys(env)) {
    throw new Error(
      `Refusing to seed API keys: NODE_ENV="${env}" is not development/test. ` +
        'Demo API-key fixtures contain raw secrets and must never be seeded outside local dev/test.',
    );
  }

  console.log('Seeding API keys...');

  // Resolve OUTSIDE the try/catch: in vault mode a resolution
  // failure must abort the seed loudly, not be swallowed by the catch below
  // (plain-SHA hashes seeded in vault mode 401 against the running API).
  const pepper = await resolveApiKeyPepper();
  console.log(
    pepper
      ? '  Key hashing: HMAC-SHA256 with API_KEY_PEPPER (matches runtime validation)'
      : '  Key hashing: plain SHA-256 (no API_KEY_PEPPER configured)',
  );

  try {
    console.log('\n📋 Development API Keys (raw values defined in seed/00-constants.ts):');
    console.log('─'.repeat(60));

    for (const { rawKey, keyName, ...apiKeyData } of DEFAULT_API_KEYS) {
      const keyHash = hashApiKey(rawKey, pepper);
      const keyPrefix = extractPrefix(rawKey);
      const keyChecksum = extractChecksum(rawKey);

      // F5 — never print the raw secret; log only a non-secret reference plus a
      // masked preview (at most the first 4 chars).
      console.log(`  ${keyName}:`);
      console.log(`    Key ID:  ${apiKeyData.id}`);
      console.log(`    Tenant:  ${apiKeyData.tenantId}`);
      console.log(`    Preview: ${maskSecret(rawKey)}`);
      console.log('');

      // Upsert by primary key (not keyHash) so re-seeding after an API_KEY_PEPPER
      // change updates the existing row's hash in place instead of colliding on id.
      await client.apiKey.upsert({
        where: { id: apiKeyData.id },
        update: {
          ...apiKeyData,
          keyName,
          keyHash,
          keyPrefix,
          keyChecksum,
        },
        create: {
          ...apiKeyData,
          keyName,
          keyHash,
          keyPrefix,
          keyChecksum,
        },
      });
    }

    console.log('─'.repeat(60));
    console.log('API key seeding completed successfully\n');
  } catch (error) {
    console.error('Error seeding API keys:', error);
  }
};
