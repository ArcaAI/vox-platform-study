// `failMode` semantics + the taxonomy governance invariants.
//
// `failMode` answers ONE question: what happens when NO tier supplies a value?
//   - `closed`          → throw. Never substitute a default. (secrets, provider/model SELECTION)
//   - `open-to-default` → fall back to `descriptor.default`.  (tuning knobs, feature flags)
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

  // Provider/model SELECTION is the second fail-closed class: an unresolved
  // selection must never silently become another tenant's or a global model.
  it('every models.* selection descriptor fails CLOSED', () => {
    const selection = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('models.'));
    expect(selection.length).toBeGreaterThan(0);
    for (const d of selection) {
      expect(d.failMode, d.key).toBe('closed');
    }
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
    'oidc.clientSecret': 'OIDC_CLIENT_SECRET',
    'api.gatewayKey': 'API_GATEWAY_KEY',
    'smr.serviceToken': 'SMR_SERVICE_TOKEN',
    'nlp.serviceToken': 'NLP_SERVICE_TOKEN',
    'guardrail.serviceToken': 'GUARDRAIL_SERVICE_TOKEN',
    'harness.serviceToken': 'HARNESS_SERVICE_TOKEN',
    'tts.serviceToken': 'TTS_SERVICE_TOKEN',
    // Lane J: four credentials the gateway already fetched through SecretsService
    // but that had no descriptor, so `vault-seed-secrets.sh` never seeded them.
    'harness.internalServiceToken': 'HARNESS_INTERNAL_SERVICE_TOKEN',
    'storageAccessKey.pepper': 'STORAGE_ACCESS_KEY_PEPPER',
    'azureStorage.connectionString': 'AZURE_STORAGE_CONNECTION_STRING',
    'azureStorage.accountKey': 'AZURE_STORAGE_ACCOUNT_KEY',
    'redis.pass': 'REDIS_PASS',
    'mqtt.pass': 'MQTT_PASS',
    'minio.accessKey': 'MINIO_ACCESS_KEY',
    'minio.secretKey': 'MINIO_SECRET_KEY',
    's3.accessKey': 'S3_ACCESS_KEY',
    's3.secretKey': 'S3_SECRET_KEY',
    // azure.speechKey / smrAzure.apiKey / smrOpenai.apiKey /
    // smrAnthropic.apiKey / ttsSarvam.apiKey were removed from the registry — the
    // STT/TTS/SMR cloud credentials are BYOK-only (db-secret / AiProviderConnection),
    // no longer vault-kv platform secrets. azure.foundryApiKey stays (out of scope).
    'azure.foundryApiKey': 'AZURE_FOUNDRY_API_KEY',
    'guardrailVllm.apiKey': 'GUARDRAIL_VLLM_API_KEY',
    'harnessJudgeOpenaiCompat.apiKey': 'HARNESS_JUDGE_OPENAI_COMPAT_API_KEY',
    'harness.claimCheck.accessKey': 'HARNESS_CLAIM_CHECK_ACCESS_KEY',
    'harness.claimCheck.secretKey': 'HARNESS_CLAIM_CHECK_SECRET_KEY',
    // ── env (SMR cloud-provider connection config) ──
    'smrOpenai.baseUrl': 'SMR_OPENAI_BASE_URL',
    'smrOpenai.organization': 'SMR_OPENAI_ORGANIZATION',
    'smrOpenai.defaultModel': 'SMR_OPENAI_DEFAULT_MODEL',
    'smrAnthropic.baseUrl': 'SMR_ANTHROPIC_BASE_URL',
    'smrAnthropic.defaultModel': 'SMR_ANTHROPIC_DEFAULT_MODEL',
    'smrVertex.project': 'SMR_VERTEX_PROJECT',
    'smrVertex.location': 'SMR_VERTEX_LOCATION',
    'smrVertex.defaultModel': 'SMR_VERTEX_DEFAULT_MODEL',
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
    'entitlements.enabledDefault': 'ENTITLEMENTS_ENABLED_DEFAULT',
    // Seed-time-only default for the metering reconcile
    // sweep, mirroring entitlements.enabledDefault exactly (see
    // metering.descriptors.ts).
    'metering.reconcile.enabledDefault': 'METERING_RECONCILE_ENABLED_DEFAULT',
    // NOTE: `TENANT_IDP_ENABLED` is deliberately ABSENT — it has no reader
    // anywhere in the repo despite an `.env.sample` comment claiming one.
    // See `feature-flags.descriptors.ts` for the evidence.
    'semanticEndpoint.enabled': 'SEMANTIC_ENDPOINT_ENABLED',
    'guardrailV2.groundedness.enabled': 'GUARDRAIL_V2_GROUNDEDNESS_ENABLED',
    'liveDoc.groundedness.enabled': 'LIVE_DOC_GROUNDEDNESS_ENABLED',
    'smr.externalGuardrail.enabled': 'SMR_EXTERNAL_GUARDRAIL_ENABLED',
    'harness.warmStartEnabled': 'HARNESS_WARM_START_ENABLED',
    'harness.nerPriorsEnabled': 'HARNESS_NER_PRIORS_ENABLED',
    'harness.atomicFactEnabled': 'HARNESS_ATOMIC_FACT_ENABLED',
    'harness.claimCheck.enabled': 'HARNESS_CLAIM_CHECK_ENABLED',
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
