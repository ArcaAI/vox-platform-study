// `failMode` semantics + the taxonomy governance invariants.
//
// `failMode` answers ONE question: what happens when NO tier supplies a value?
//   - `closed` → throw. Never substitute a default. (secrets, provider/model SELECTION)
//   - `open-to-default` → fall back to `descriptor.default`. (tuning knobs, feature flags)
//
// The reference behaviour being generalised is
// `apps/guardrail/src/guardrail/core/tenant_config.py` — "Selection is DB-only
// (fail-closed at the dependency layer when the resolved config is empty) …
// the caller must not fall back to env for provider/model selection."

import { ArgumentInvalidException } from '@arcaai/exceptions';
import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { SettingsRegistry } from '../settings-registry';
import { toEnvVarName } from '../registry.types';
import type { SettingDescriptor } from '../registry.types';

function desc(over: Partial<SettingDescriptor> = {}): SettingDescriptor {
  return {
    key: 'test.flag',
    tier: 'db-config',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'TestSubject',
    category: 'Test',
    failMode: 'open-to-default',
    ...over,
  };
}

describe('SettingsRegistry — secret ⇒ fail-closed (assembly invariant)', () => {
  it('rejects a secret-sensitivity descriptor that is not failMode closed', () => {
    const r = new SettingsRegistry();
    expect(() => r.register(desc({ key: 'bad.secret', sensitivity: 'secret', dataType: 'secret', failMode: 'open-to-default' }))).toThrow(
      /secret.*fail.*closed/i,
    );
  });

  it('accepts a secret-sensitivity descriptor that is failMode closed', () => {
    const r = new SettingsRegistry();
    expect(() => r.register(desc({ key: 'ok.secret', sensitivity: 'secret', dataType: 'secret', failMode: 'closed' }))).not.toThrow();
  });

  it('lists every secret descriptor via secrets()', () => {
    const r = new SettingsRegistry().registerAll([
      desc({ key: 'a' }),
      desc({ key: 'b', sensitivity: 'secret', dataType: 'secret', failMode: 'closed' }),
    ]);
    expect(r.secrets().map((d) => d.key)).toEqual(['b']);
  });

  // `sampleValue` puts a ready-to-use value into a
  // COMMITTED template file (`.env.sample`) — it must never coexist with
  // `sensitivity: 'secret'`, or a "sample" becomes a real leaked credential.
  it('rejects a secret-sensitivity descriptor that declares a sampleValue', () => {
    const r = new SettingsRegistry();
    expect(() =>
      r.register(desc({ key: 'bad.secret.sample', sensitivity: 'secret', dataType: 'secret', failMode: 'closed', sampleValue: 'not-a-secret-honest' })),
    ).toThrow(/secret.*sampleValue/i);
  });

  it('accepts a non-secret descriptor that declares a sampleValue', () => {
    const r = new SettingsRegistry();
    expect(() => r.register(desc({ key: 'ok.sample', sampleValue: 'redis://localhost:6379' }))).not.toThrow();
  });

  it('no registered secret declares a sampleValue', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.secrets()) {
      expect(d.sampleValue, d.key).toBeUndefined();
    }
  });
});

describe('HOPE_SETTINGS_REGISTRY — failMode governance', () => {
  it('every registered descriptor declares a failMode', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      expect(['closed', 'open-to-default'], d.key).toContain(d.failMode);
    }
  });

  it('every secret-sensitivity descriptor fails CLOSED (never leaks a neighbouring value)', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.secrets()) {
      expect(d.failMode, d.key).toBe('closed');
    }
  });

  // Provider/model SELECTION is the second fail-closed class — and since
  // TASK-881 it is NOT a setting at all: the `models.*` projection over the
  // `AiTaskDefault` facade is gone, and selection resolves through
  // `AiRoutingPolicyService.resolveDefault`, which fails closed on its own
  // (a null model is the caller's 503, never a substituted default).
  it('registers no models.* selection descriptor — selection is not a setting', () => {
    expect(HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('models.'))).toEqual([]);
  });

  // Tuning knobs / feature flags fall back to the descriptor default, so a
  // missing DB row degrades to today's behaviour instead of an outage.
  it('every kill-switch is open-to-default AND defaults OFF', () => {
    const switches = HOPE_SETTINGS_REGISTRY.killSwitches();
    expect(switches.length).toBeGreaterThan(0);
    for (const ks of switches) {
      expect(ks.failMode, ks.key).toBe('open-to-default');
      expect(ks.default, ks.key).not.toBe(true);
    }
  });

  // `env` is the bootstrap floor: there is no admin write path at all, so
  // claiming a CASL subject would imply an editor surface that does not exist.
  it('every env-tier descriptor declares editableBy "none" and system maxScope', () => {
    const envTier = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.tier === 'env');
    expect(envTier.length).toBeGreaterThan(0);
    for (const d of envTier) {
      expect(d.editableBy, d.key).toBe('none');
      expect(d.maxScope, d.key).toBe('system');
    }
  });

  it('no non-env descriptor claims editableBy "none"', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      if (d.tier !== 'env') expect(d.editableBy, d.key).not.toBe('none');
    }
  });

  // `targetTier` records the eventual home when the present-tense `tier` is
  // NOT where the key ends up. Setting it equal to `tier` is meaningless noise.
  it('targetTier, when present, differs from the current tier', () => {
    for (const d of HOPE_SETTINGS_REGISTRY.list()) {
      if (d.targetTier !== undefined) expect(d.targetTier, d.key).not.toBe(d.tier);
    }
  });
});

describe('toEnvVarName — the mechanical dotted-key ↔ env-var 1:1', () => {
  it('maps dotted lowerCamel segments to SCREAMING_SNAKE', () => {
    expect(toEnvVarName('jwt.secretKey')).toBe('JWT_SECRET_KEY');
    expect(toEnvVarName('storage.minio.endpoint')).toBe('STORAGE_MINIO_ENDPOINT');
    expect(toEnvVarName('harness.claimCheck.accessKey')).toBe('HARNESS_CLAIM_CHECK_ACCESS_KEY');
  });

  it('keeps a trailing digit attached to its letter group', () => {
    expect(toEnvVarName('guardrailV2.groundedness.enabled')).toBe('GUARDRAIL_V2_GROUNDEDNESS_ENABLED');
  });

  it('handles a single-segment bootstrap key', () => {
    expect(toEnvVarName('databaseUrl')).toBe('DATABASE_URL');
    expect(toEnvVarName('port')).toBe('PORT');
  });

  it('is idempotent on an already-SCREAMING_SNAKE segment', () => {
    expect(toEnvVarName('NODE_ENV')).toBe('NODE_ENV');
  });
});

// The mapping is only a CONTRACT if it is checked against the names the running
// code actually reads. Each expectation below was verified against a live reader
// (grep-confirmed 2026-07-25); a rename on either side breaks this test.
describe('env/vault-kv descriptor keys resolve to the real variable names', () => {
  const EXPECTED: Record<string, string> = {
    // ── vault-kv (Vault kv-v2 `secret/hope/<NAME>`, SecretsService.getSecret(NAME)) ──
    'jwt.secretKey': 'JWT_SECRET_KEY',
    'session.secretKey': 'SESSION_SECRET_KEY',
    'api.keyPepper': 'API_KEY_PEPPER',
    // `oidc.clientSecret` was here — the platform OIDC tier is retired, so the
    // descriptor is gone and nothing seeds `OIDC_CLIENT_SECRET` into Vault.
    // Identity resolves the tenant's own `TenantIdentityProvider.encryptedSecretRef`.
    'api.gatewayKey': 'API_GATEWAY_KEY',
    'text.serviceToken': 'TEXT_SERVICE_TOKEN',
    // `nlp.serviceToken` was here until TASK-872: no gateway call site asks for
    // `NLP_SERVICE_TOKEN` and no `apps/nlp` pydantic field carries it, so the
    // descriptor seeded a Vault path nothing reads. Its `text` / `tts` siblings
    // stay — `vault-kv-coverage.test.ts` proved both names are still fetched
    // through `SecretsService`.
    'guardrail.serviceToken': 'GUARDRAIL_SERVICE_TOKEN',
    'harness.serviceToken': 'HARNESS_SERVICE_TOKEN',
    // `tts.serviceToken` left with TASK-879/880 once its last reader (the service-release guard) went.
    // Lane J: four credentials the gateway already fetched through SecretsService
    // but that had no descriptor, so `vault-seed-secrets.sh` never seeded them.
    'harness.internalServiceToken': 'HARNESS_INTERNAL_SERVICE_TOKEN',
    'storageAccessKey.pepper': 'STORAGE_ACCESS_KEY_PEPPER',
    // dedicated webhook-signing pepper — deliberately separate
    // from `api.keyPepper` (see platform-secrets.descriptors.ts).
    'webhook.secretPepper': 'WEBHOOK_SECRET_PEPPER',
    'azureStorage.connectionString': 'AZURE_STORAGE_CONNECTION_STRING',
    'azureStorage.accountKey': 'AZURE_STORAGE_ACCOUNT_KEY',
    'redis.pass': 'REDIS_PASS',
    'mqtt.pass': 'MQTT_PASS',
    'minio.accessKey': 'MINIO_ACCESS_KEY',
    'minio.secretKey': 'MINIO_SECRET_KEY',
    's3.accessKey': 'S3_ACCESS_KEY',
    's3.secretKey': 'S3_SECRET_KEY',
    // azure.speechKey / textAzure.apiKey / textOpenai.apiKey /
    // textAnthropic.apiKey / ttsSarvam.apiKey were removed from the registry — the
    // STT/TTS/TEXT cloud credentials are BYOK-only (db-secret / AiProviderConnection),
    // no longer vault-kv platform secrets. azure.foundryApiKey stays (out of scope).
    // `azure.foundryApiKey` REMOVED: the env fallback closed in
    // `azure_foundry_loader.py`, so the key now comes only from a tenant / SYSTEM
    // AiProviderConnection override. Registering it kept `vault-seed-secrets.sh`
    // provisioning a Vault secret nothing reads, and advertised a platform tier
    // for a BYO-only provider.
    // harnessJudgeOpenaiCompat.apiKey was removed for the same reason — the
    // harness LLM-as-judge credential is BYO-only now
    // (`AiProviderConnection(service='llm', provider='openai-compat')`), resolved
    // per activity through `GET /internal/harness/provider-credential`, with the
    // env path structurally closed on the Python side.
    'harness.claimCheck.accessKey': 'HARNESS_CLAIM_CHECK_ACCESS_KEY',
    'harness.claimCheck.secretKey': 'HARNESS_CLAIM_CHECK_SECRET_KEY',
    // TEXT's cloud-provider connection config (`textOpenai.*`, `textAnthropic.*`,
    // `textVertex.*`) is GONE from the registry — lane B deleted the env
    // vars behind it. "The platform default for a provider" and "the tenant's own
    // connection" were two data classes describing one thing, with only the
    // tenant half governable; there is one now (`AiProviderConnection`, whose
    // SYSTEM row IS the platform default). See
    // `descriptors/text-provider-connections.descriptors.ts`.
    // ── env (bootstrap floor) ──
    nodeEnv: 'NODE_ENV',
    databaseUrl: 'DATABASE_URL',
    directUrl: 'DIRECT_URL',
    'prisma.pgMax': 'PRISMA_PG_MAX',
    'redis.host': 'REDIS_HOST',
    'redis.port': 'REDIS_PORT',
    'redis.url': 'REDIS_URL',
    'vault.addr': 'VAULT_ADDR',
    'vault.roleId': 'VAULT_ROLE_ID',
    'vault.secretId': 'VAULT_SECRET_ID',
    'vault.wrappedSecretId': 'VAULT_WRAPPED_SECRET_ID',
    'vault.kvMount': 'VAULT_KV_MOUNT',
    'vault.kvPrefix': 'VAULT_KV_PREFIX',
    'vault.dbAdminPass': 'VAULT_DB_ADMIN_PASS',
    secretsProvider: 'SECRETS_PROVIDER',
    // Storage bootstrap fallback, superseded by the SYSTEM TenantStorageConfig row
    // once seeded.
    'minio.endpoint': 'MINIO_ENDPOINT',
    // Object-store TLS certificate verification. Bare (unprefixed) like
    // `MINIO_ENDPOINT`, which is also the variable apps/stt already reads.
    'minio.certCheck': 'MINIO_CERT_CHECK',
    port: 'PORT',
    logLevel: 'LOG_LEVEL',
    // `corsAllowedOrigins` is deliberately ABSENT — the origin-enforcement work removed the
    // descriptor entirely (no env var ever controls the CORS allow-list; the
    // `TenantAllowedOrigin` table is the sole source). It is `global-kv`-tier
    // anyway (filtered out by the `env`/`vault-kv` guard below), so its
    // removal changes nothing this describe block asserts.
    'shutdown.timeoutMs': 'SHUTDOWN_TIMEOUT_MS',
    'shutdown.drainDelayMs': 'SHUTDOWN_DRAIN_DELAY_MS',
    'apiKey.maxLifetimeDays': 'API_KEY_MAX_LIFETIME_DAYS',
    'apiKey.allowQueryParam': 'API_KEY_ALLOW_QUERY_PARAM',
    'refreshToken.ttlSeconds': 'REFRESH_TOKEN_TTL_SECONDS',
    'rateLimit.enabled': 'RATE_LIMIT_ENABLED',
    'rateLimit.maxRequests': 'RATE_LIMIT_MAX_REQUESTS',
    'rateLimit.windowMs': 'RATE_LIMIT_WINDOW_MS',
    'registration.selfSignupEnabled': 'REGISTRATION_SELF_SIGNUP_ENABLED',
    'workflowExposure.enabled': 'WORKFLOW_EXPOSURE_ENABLED',
    // `entitlements.enabledDefault` and `metering.reconcile.enabledDefault`
    // were here — the two seed-time-only companions. TASK-872 deleted both
    // descriptors: `seed/15-entitlements.ts` reads the host env directly, so
    // the variables still work as overrides and stay in `turbo.json#globalEnv`
    // via that read, but nothing running reads a descriptor for them.
    // NOTE: `TENANT_IDP_ENABLED` is deliberately ABSENT — it has no reader
    // anywhere in the repo despite an `.env.sample` comment claiming one.
    // See `feature-flags.descriptors.ts` for the evidence.
    // NOTE: `semanticEndpoint.enabled` (bare `SEMANTIC_ENDPOINT_ENABLED`) is
    // deliberately ABSENT — TASK-877 deleted its only reader along with the rest
    // of the `stt.semanticEndpoint.*` family; see `stt-runtime.descriptors.test.ts`.
    // `guardrailV2.groundedness.enabled` was here. Removed by TASK-872: no
    // pydantic field carries `GUARDRAIL_V2_GROUNDEDNESS_ENABLED` any more (the
    // live gate is `guardrail.groundedness.enabled`, tier `global-kv`, served
    // on the pull route), so this line asserted a name with no reader.
    'liveDoc.groundedness.enabled': 'LIVE_DOC_GROUNDEDNESS_ENABLED',
    // `text.externalGuardrail.enabled` is no longer env-tier: lane B
    // deleted `TEXT_EXTERNAL_GUARDRAIL_ENABLED` and made it a `global-kv`
    // kill-switch served on the effective-config pull route, so a clinical
    // deployment turns moderation on without a redeploy.
    // `harness.{warmStartEnabled,nerPriorsEnabled,atomicFactEnabled}` were here — env
    // FALLBACKS for the `HarnessPolicy` columns of the same name. TASK-882 deleted the
    // descriptors and every env read behind them; the column is the only source.
    'harness.claimCheck.enabled': 'HARNESS_CLAIM_CHECK_ENABLED',
    // THE canonical internal service-to-service credential (owner decision
    // D-D, 2026-08-17) — one shared token on every internal hop. The legacy
    // per-service `*_SERVICE_TOKEN` entries above are retained only as a
    // backward-compatibility fallback, so both appear here during the overlap.
    'internal.accessToken': 'INTERNAL_ACCESS_TOKEN',
    // The five `tts.*.enabled` flags were listed here as bootstrap fallbacks whose env path could
    // not be closed until the k8s manifests in `arca/hope-v2-deployment` stopped setting them.
    // TASK-879 removed that whole question rather than answering it: "may this engine serve" is
    // an `AiProviderConnection` row's three-state `enabled`, resolved per request into the
    // pushed spec, so there is no key, no env variable and no manifest coupling left to
    // sequence.
  };

  /**
   * Descriptors whose value is addressed by a Vault kv-v2 PATH rather than by an
   * environment variable, so the dotted↔env 1:1 does not apply to them.
   *
   * `storage.platformDefault.credentials` describes the
   * `TenantStorageConfig.credentialsRef` pointer — the platform storage row names a
   * Vault path instead of carrying keys. The values BEHIND that pointer are the
   * ordinary env-bound secrets `minio.accessKey` / `minio.secretKey`, which are
   * registered separately above and ARE covered by the 1:1 assertion. Excluding the
   * pointer keeps the invariant meaningful rather than weakening it for everything.
   */
  const KEYS_ADDRESSED_BY_VAULT_PATH = new Set(['storage.platformDefault.credentials']);

  it('every env/vault-kv descriptor derives its real variable name', () => {
    const bound = HOPE_SETTINGS_REGISTRY.list().filter(
      (d) => (d.tier === 'env' || d.tier === 'vault-kv') && !KEYS_ADDRESSED_BY_VAULT_PATH.has(d.key),
    );
    expect(bound.length).toBeGreaterThan(0);
    for (const d of bound) {
      expect(EXPECTED[d.key], `no expected env name recorded for '${d.key}'`).toBeDefined();
      expect(toEnvVarName(d.key), d.key).toBe(EXPECTED[d.key]);
    }
  });

  it('registers every expected env/vault-kv key (no silent drop)', () => {
    for (const key of Object.keys(EXPECTED)) {
      expect(HOPE_SETTINGS_REGISTRY.has(key), key).toBe(true);
    }
  });
});

describe('API_KEY_PEPPER — staged, keyVersion-aware rotation', () => {
  const pepper = () => HOPE_SETTINGS_REGISTRY.getOrThrow('api.keyPepper');

  it('is a vault-kv secret that fails closed', () => {
    expect(pepper()).toMatchObject({ tier: 'vault-kv', sensitivity: 'secret', dataType: 'secret', failMode: 'closed' });
  });

  it('documents the staged rotation procedure (a swap invalidates every API key)', () => {
    const description = pepper().description ?? '';
    expect(description).toMatch(/keyVersion/);
    expect(description).toMatch(/stage/i);
    expect(description).toMatch(/invalidat/i);
  });

  it('throws ArgumentInvalidException through the read facade rather than surfacing a value', () => {
    // Secrets are refused by EffectiveSettingsService before any tier is read;
    // the assertion here is on the classification that drives that refusal.
    expect(pepper().sensitivity).toBe('secret');
    expect(() => HOPE_SETTINGS_REGISTRY.assertWithinMaxScope('api.keyPepper', 'tenant')).toThrow(ArgumentInvalidException);
  });
});
