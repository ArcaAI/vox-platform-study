// Platform secrets — the `vault-kv` tier.
//
// Data class 1: a SHARED platform credential, operator-set, living in Vault
// kv-v2 at `<VAULT_KV_MOUNT>/data/<VAULT_KV_PREFIX>/<NAME>` (defaults
// `secret/data/hope/<NAME>`) and read through `SecretsService.getSecret(NAME)`.
// `NAME` is exactly `toEnvVarName(descriptor.key)` — the mechanical 1:1
// mapping — which is why the seeding script (`scripts/vault-seed-secrets.sh`) needs
// no key table of its own.
//
// CLASSIFICATION RULES APPLIED HERE
//   - tier `vault-kv`     ⇒ the secret ALREADY resolves through SecretsService
//                           today (a Vault-backed `SECRETS_PROVIDER=vault`
//                           deployment reads it from Vault; `env` provider reads
//                           the same NAME from the process environment — that is
//                           a PROVIDER choice, not a different tier).
//   - `targetTier` absent ⇒ this classification is final; nothing migrates.
//   - sensitivity `secret`⇒ `failMode: 'closed'` is MANDATORY and enforced by
//                           `SettingsRegistry.register`. A credential that fell
//                           back to a default would authenticate as someone else.
//   - maxScope `system`   ⇒ platform-wide. PER-TENANT credentials are a different
//                           data class (`db-secret`, Vault-Transit ciphertext in
//                           a DB column — see `tts.descriptors.ts`), never here.
//   - `globalOnly: true`  ⇒ operator/SUPER_ADMIN surface only.
//
// NOTHING IS MIGRATED BY THIS FILE. A descriptor is metadata: it states where the
// value lives, who may set it, and how it fails. Moving values into Vault is the
// operator step performed by `scripts/vault-seed-secrets.sh`.
//
// DELIBERATELY NOT REGISTERED (verified 2026-07-25):
//   - `QDRANT_API_KEY`      — NOT a runtime credential, but NOT dead either. No
//                             application service authenticates to Qdrant (the
//                             harness retrieval config, `HARNESS_RETRIEVAL_` prefix,
//                             has only `qdrant_url` and `qdrant_timeout_s`). Its one
//                             reader is the provisioning script
//                             `infrastructure/docker/scripts/init-qdrant-collections.py:23`,
//                             which runs outside the application env surface and is
//                             documented in `infrastructure/docker/env.stt-dev.example`.
//                             Left unregistered because the registry catalogs the
//                             APPLICATION surface, not one-shot infra provisioning.
//                             (An earlier revision of this comment claimed "no reader
//                             anywhere" — that was wrong; corrected at the wave-3 merge.)
//   - `AZURE_OPENAI_API_KEY`— read ONLY by `apps/text/src/text/tests/e2e/conftest.py`
//                             (a test fixture parsing a dotenv file directly). No
//                             runtime reader. SMR's Azure credential
//                             (`TEXT_AZURE_API_KEY`) is no longer a platform-secret
//                             either — it is BYOK-only (`db-secret`, resolved from
//                             `AiProviderConnection`), so nothing is registered here.
//   - `STT_SERVICE_TOKEN`   — does not exist. STT authenticates to the gateway
//                             with `X-Internal-Service-Key` + `API_GATEWAY_KEY`
//                             (`InternalServiceTokenGuard.SERVICE_SECRETS.stt`),
//                             so `API_GATEWAY_KEY` is registered in its place.
//   - `VAULT_DB_ADMIN_PASS` — cannot live in Vault: it is the credential VAULT
//                             ITSELF uses to reach PostgreSQL, consumed at Vault
//                             provisioning time by `dev-init.sh` /
//                             `setup-dev-vault-db.sh` / compose. Bootstrap floor
//                             ⇒ `env` tier (see `bootstrap-env.descriptors.ts`).

import { SettingDescriptor } from '../registry.types';

/** Shared shape for every platform secret; only key/label/description vary. */
function platformSecret(key: string, label: string, description: string, category = 'Credentials'): SettingDescriptor {
  return {
    key,
    tier: 'vault-kv',
    dataType: 'secret',
    sensitivity: 'secret',
    maxScope: 'system',
    // `all` is the CASL manage-everything subject used by every other
    // platform-owned descriptor in this registry (see model-defaults / platform-ops).
    editableBy: 'all',
    globalOnly: true,
    failMode: 'closed',
    category,
    label,
    description,
  };
}

export const PLATFORM_SECRET_SETTINGS: SettingDescriptor[] = [
  // ── Core auth material (all in COMMON_SERVICE_WARMUP_KEYS) ────────────────
  platformSecret(
    'jwt.secretKey',
    'JWT signing secret',
    'HS256 signing secret for gateway-issued access tokens. Warmed at boot; `apps/api/src/main.ts` refuses to start when it is still a placeholder. Rotating it invalidates every outstanding access token immediately (they are short-lived, so the blast radius is one token TTL).',
    'Authentication',
  ),
  platformSecret(
    'session.secretKey',
    'Session signing secret',
    'Signing/encryption secret for server-side session material. Rotating it invalidates existing sessions; users re-authenticate.',
    'Authentication',
  ),
  {
    ...platformSecret('api.keyPepper', 'API key pepper', '', 'Authentication'),
    // The one secret whose rotation is a CLIFF rather than a blip.
    description:
      'Server-side pepper mixed into every API-key hash. CHANGING IT INVALIDATES EVERY ISSUED API KEY AT THE INSTANT IT CHANGES — a stored hash computed under pepper vN can never be verified under vN+1. ' +
      'ROTATION IS THEREFORE STAGED, NEVER SWAPPED, and is keyVersion-aware in exactly the way `GlobalSetting` already models secret material (`encryptedValue` + `keyVersion`): ' +
      '(1) write the NEW pepper as a new Vault kv-v2 version — kv-v2 keeps prior versions, so vN stays readable; ' +
      '(2) verification reads the keyVersion recorded on the ApiKey row and verifies under THAT pepper, so vN and vN+1 keys are both valid during the overlap; ' +
      '(3) newly issued and re-hashed keys are stamped with the new keyVersion; ' +
      '(4) once no row still references vN — or the announced overlap window closes — retire vN. ' +
      'Skipping the overlap is an outage for every integration at once. Vault kv-v2 versioning is the mechanism; the keyVersion column is what makes it staged rather than a coin flip. ' +
      'STATUS (lane J): step (2)’s READ PATH now exists — `SecretFetchOptions.version` addresses a specific kv-v2 version through ' +
      '`SecretsService.getSecret(key, { version })`, cached per (key, version) and evicted together by `invalidate(key)`. ' +
      'What is still MISSING is the per-row half: `ApiKey` has no pepper-version column, so nothing records which pepper produced a stored hash, ' +
      'and `ApiKeyService.verify` has nothing to pass. Until that column, its migration, its domain trio and the issue/verify stamping land, ' +
      'a pepper change remains a cliff — the read path alone does not make the rotation staged.',
  },
  platformSecret(
    'oidc.clientSecret',
    'OIDC client secret',
    'Client secret for the platform OIDC relying-party registration. Absent ⇒ OIDC authentication is disabled (a logged WARN, not a crash) — see `auth.service.module.ts`.',
    'Authentication',
  ),

  // ── Service-to-service tokens ─────────────────────────────────────────────
  // The gateway fronts every Python service; these are the shared secrets on the
  // `X-Service-Token` hop in BOTH directions (gateway → service, and service →
  // gateway `/api/v1/internal/effective-config` via `InternalServiceTokenGuard`).
  platformSecret(
    'internal.accessToken',
    'Internal access token',
    'THE canonical internal service-to-service credential (owner decision D-D, 2026-08-17): **one** shared access token, ' +
      'identical across every service, set by the DevOps engineer, internal use only. It is presented and accepted as ' +
      '`X-Service-Token` on every internal hop — gateway↔text/nlp/guardrail/harness/tts and every peer-to-peer hop ' +
      '(harness→text/nlp/guardrail, text→guardrail, nlp→text). ' +
      'There is deliberately NO per-service and NO per-pair token in the target state: the `*_SERVICE_TOKEN` family below ' +
      '(`TEXT_`, `NLP_`, `GUARDRAIL_`, `HARNESS_`, `TTS_`, and harness’s outbound `HARNESS_TEXT_`/`HARNESS_NLP_`) is retained ' +
      'ONLY as a zero-cost backward-compatibility fallback — every inbound middleware accepts EITHER this token or its own ' +
      'legacy secret, and every outbound client PREFERS this token and falls back to its legacy per-target secret when unset. ' +
      'Set this one variable and the legacy family can all be dropped. ' +
      'This is the sanctioned env-var exception to D-B (configuration lives in the DB) — it is bootstrap-floor auth material, ' +
      'delivered from Vault in deployed environments. NOT the same thing as `HARNESS_INTERNAL_SERVICE_TOKEN`, which gates ' +
      'the harness knowledge-ingest endpoint only, nor `API_GATEWAY_KEY`, which must be a real ApiKey row (see below).',
    'Service Tokens',
  ),
  platformSecret(
    'text.serviceToken',
    'Text service token',
    "Shared secret on the gateway↔SMR hop. SMR reads it as `settings.service_token` under its `TEXT_` pydantic prefix; the gateway resolves the same name for outbound proxying and for `InternalServiceTokenGuard`'s inbound check.",
    'Service Tokens',
  ),
  platformSecret('nlp.serviceToken', 'NLP service token', 'Shared secret on the gateway↔NLP hop (`X-Service-Token`).', 'Service Tokens'),
  platformSecret(
    'guardrail.serviceToken',
    'Guardrail service token',
    'Shared secret on the gateway↔guardrail hop (`X-Service-Token`).',
    'Service Tokens',
  ),
  platformSecret(
    'harness.serviceToken',
    'Harness service token',
    'Shared secret on the gateway↔harness hop. Fetched on demand (not a warmup key) by `HarnessOpsClient` / `HarnessGatewayService` / `HarnessServiceTokenGuard`. It MUST equal the harness process’s own `HARNESS_SERVICE_TOKEN`, or every `/api/v1/internal/harness/*` call 401s.',
    'Service Tokens',
  ),
  platformSecret('tts.serviceToken', 'TTS service token', 'Shared secret on the gateway↔TTS hop (`X-Service-Token`).', 'Service Tokens'),
  platformSecret(
    'harness.internalServiceToken',
    'Harness knowledge-ingest token',
    'SECOND, SEPARATE harness credential — NOT an alias of `HARNESS_SERVICE_TOKEN`. It gates the knowledge-ingest endpoint only ' +
      '(`apps/harness/.../api/endpoints/knowledge.py`, pydantic field `internal_service_token` under the `HARNESS_` prefix) and is ' +
      'resolved by `KnowledgeIngestClient` for the outbound `X-Service-Token`. Added by lane J: it was read through SecretsService ' +
      'but had no descriptor, so `vault-seed-secrets.sh` never seeded it and every ingest call would 401 on a Vault-backed deployment.',
    'Service Tokens',
  ),
  platformSecret(
    'api.gatewayKey',
    'STT gateway key',
    'The credential STT presents to the gateway. STT is the one service that authenticates with `X-Internal-Service-Key` rather than `X-Service-Token`, reusing this key instead of minting a second STT credential (`InternalServiceTokenGuard.SERVICE_SECRETS.stt`). There is no `STT_SERVICE_TOKEN`. ' +
      'NOT a free-form shared secret like the `*_SERVICE_TOKEN` values: `X-Internal-Service-Key` is also read by the GLOBAL `UnifiedAuthGuard` (`ApiKeyService.extractApiKeyFromRequest`), so this MUST be the RAW value of a registered ACTIVE SERVICE_ACCOUNT ApiKey row — a random secret with no matching row 401s every `/internal/stt/*` callback (BUG-013). Dev uses the seeded fixture; provision one with `pnpm gen:api-key`.',
    'Service Tokens',
  ),

  // ── Data-plane credentials ────────────────────────────────────────────────
  platformSecret(
    'redis.pass',
    'Redis password',
    'Redis AUTH password. Resolved through SecretsService and layered over the env value by `ConfigService.applySecretOverrides`.',
    'Data Plane',
  ),
  platformSecret('mqtt.pass', 'MQTT password', 'MQTT broker password, consumed by `MqttService` via `ConfigService`.', 'Data Plane'),
  platformSecret(
    'minio.accessKey',
    'MinIO access key',
    'MinIO/S3 access key for platform object storage. NOTE: the per-tenant / platform-default STORAGE CONFIG (endpoint, region, path style, prefix) is a separate concern owned by `TenantStorageConfig`; only the credential lives here, referenced by `credentialsRef`.',
    'Data Plane',
  ),
  platformSecret('minio.secretKey', 'MinIO secret key', 'MinIO/S3 secret key for platform object storage.', 'Data Plane'),
  platformSecret(
    's3.accessKey',
    'S3 access key',
    'S3-protocol access key read by `S3Service`. In local dev this aliases the MinIO credential (HOPE speaks S3 to MinIO); in a deployed environment it may name a distinct S3 principal.',
    'Data Plane',
  ),
  platformSecret('s3.secretKey', 'S3 secret key', 'S3-protocol secret key read by `S3Service`.', 'Data Plane'),
  platformSecret(
    'azureStorage.connectionString',
    'Azure Blob connection string',
    'Full Azure Storage connection string (carries the account key) for the AZURE storage provider. Read by ' +
      '`BlobStorageProviderFactory.buildAzureProvider` AFTER the SYSTEM row’s `credentialsRef`, i.e. it is the env/kv fallback of the ' +
      'same two-step order as `S3_ACCESS_KEY`. Preferred over `AZURE_STORAGE_ACCOUNT_KEY`.',
    'Data Plane',
  ),
  platformSecret(
    'azureStorage.accountKey',
    'Azure Blob shared account key',
    'Azure Storage shared account key — the alternative to `AZURE_STORAGE_CONNECTION_STRING` when the endpoint is composed from ' +
      '`accountName` + `endpointSuffix` on the storage config row.',
    'Data Plane',
  ),
  platformSecret(
    'storageAccessKey.pepper',
    'Storage access-key pepper',
    'HMAC pepper for hashing tenant STORAGE access-key secrets (`StorageAccessKeyService.hashSecretForStorage`). Falls back to the ' +
      'shared `API_KEY_PEPPER` when unset, then to un-peppered SHA-256 — so it inherits `API_KEY_PEPPER`’s rotation cliff: changing it ' +
      'invalidates every stored storage access key. Stage a rotation the same way (see `api.keyPepper`).',
    'Authentication',
  ),
  {
    ...platformSecret('webhook.secretPepper', 'Webhook signing-secret encryption key', '', 'Authentication'),
    // TASK-727 decision (owner directive, 2026-08-16): DEDICATED pepper, deliberately
    // NOT falling back to `API_KEY_PEPPER` the way `storageAccessKey.pepper` does.
    description:
      'Key-derivation material for the REVERSIBLE AES-256-GCM encryption `WebhookService` applies to every server-generated ' +
      'webhook signing secret before storage (`WebhookService.encryptSecretForStorage`). NOT an HMAC pepper like `api.keyPepper` — ' +
      'webhook signing requires the platform to recover the RAW secret at delivery time (to compute an HMAC the receiver, who only ' +
      'ever saw the raw secret once, can independently verify), so the stored form must be decryptable, not a one-way hash. See ' +
      "`WebhookService`'s class doc for the full rationale. " +
      'DELIBERATELY A SEPARATE VAULT SECRET FROM `API_KEY_PEPPER` — reusing the API-key pepper would couple two independent ' +
      'rotation lifecycles: rotating one to respond to an API-key compromise would silently invalidate every webhook signature ' +
      '(and vice versa), and a caller with no legitimate reason to hold both credentials would need only one to attack both surfaces. ' +
      'Unset ⇒ falls back to a fixed local key-derivation string (no cross-credential fallback chain), matching `ApiKeyService`’s own ' +
      'legacy/no-SecretsService fallback — NOT a security posture to rely on in a Vault-backed deployment. ' +
      "Rotation is a bigger event than `api.keyPepper`'s stage-and-overlap pattern: changing this key makes every EXISTING stored " +
      'ciphertext undecryptable (there is no keyVersion column here either), so a rotation must re-encrypt every `Webhook.hashedSecret` ' +
      'row under the new key in the same operation — a re-encryption migration, not a Vault kv-v2 version bump alone.',
  },

  // ── AI provider credentials (platform-owned; BYO tenant keys are db-secret) ─
  // The STT/TTS/SMR cloud credentials (`AZURE_SPEECH_KEY`,
  // `TTS_SARVAM_API_KEY`, `TEXT_AZURE_API_KEY`, `TEXT_OPENAI_API_KEY`,
  // `TEXT_ANTHROPIC_API_KEY`) are NO LONGER platform-secrets. They moved fully to
  // the `db-secret` tier: a platform default is a SYSTEM-tenant row in
  // `AiProviderConnection` (Vault-Transit ciphertext), resolved by the gateway and
  // injected per request. The Python services no longer read any env fallback for
  // them, so registering them here (which would seed a `vault-kv` secret and add
  // them to `turbo#globalEnv`) is wrong — they are removed. Bedrock/Vertex use
  // ambient cloud credentials (no static key). `azure.foundryApiKey` stays: it is a
  // disabled-by-default preview engine, out of that credential-move's scope.
  platformSecret('azure.foundryApiKey', 'Azure AI Foundry key', 'Azure AI Foundry credential used by the STT Foundry model loader.', 'AI Providers'),
  platformSecret(
    'guardrailVllm.apiKey',
    'Guardrail vLLM key',
    "Bearer credential for guardrail's vLLM OpenAI-compatible endpoint (`GUARDRAIL_VLLM_` prefix). Self-hosted endpoints commonly accept a placeholder, but it is still a credential and is classified as one.",
    'AI Providers',
  ),
  platformSecret(
    'harnessJudgeOpenaiCompat.apiKey',
    'Harness judge endpoint key',
    'Bearer credential for the harness LLM-as-judge OpenAI-compatible endpoint (`HARNESS_JUDGE_OPENAI_COMPAT_` prefix). Connection config only — WHICH judge model runs is `models.harness.judge`, a fail-closed db-config selection.',
    'AI Providers',
  ),

  // ── Harness claim-check object store (PHI blobs) ──────────────────────────
  platformSecret(
    'harness.claimCheck.accessKey',
    'Claim-check store access key',
    'S3/MinIO access key for the harness claim-check blob store. The offloaded payloads are clinical content, so the store is SELF-HOSTED by contract — this credential must never address a cloud bucket.',
    'Data Plane',
  ),
  platformSecret(
    'harness.claimCheck.secretKey',
    'Claim-check store secret key',
    'S3/MinIO secret key for the harness claim-check blob store (self-hosted only; PHI must not egress).',
    'Data Plane',
  ),
];
