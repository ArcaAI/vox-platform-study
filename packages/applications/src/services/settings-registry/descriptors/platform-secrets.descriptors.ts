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
//   - tier `vault-kv` ⇒ the secret ALREADY resolves through SecretsService
//                           today (a Vault-backed `SECRETS_PROVIDER=vault`
//                           deployment reads it from Vault; `env` provider reads
//                           the same NAME from the process environment — that is
//                           a PROVIDER choice, not a different tier).
//   - `targetTier` absent ⇒ this classification is final; nothing migrates.
//   - sensitivity `secret`⇒ `failMode: 'closed'` is MANDATORY and enforced by
//                           `SettingsRegistry.register`. A credential that fell
//                           back to a default would authenticate as someone else.
//   - maxScope `system` ⇒ platform-wide. PER-TENANT credentials are a different
//                           data class (`db-secret`, Vault-Transit ciphertext in
//                           a DB column — see `tts.descriptors.ts`), never here.
//   - `globalOnly: true` ⇒ operator/SUPER_ADMIN surface only.
//
// NOTHING IS MIGRATED BY THIS FILE. A descriptor is metadata: it states where the
// value lives, who may set it, and how it fails. Moving values into Vault is the
// operator step performed by `scripts/vault-seed-secrets.sh`.
//
// DELIBERATELY NOT REGISTERED (verified 2026-07-25):
//   - `QDRANT_API_KEY` — NOT a runtime credential, but NOT dead either. No
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
//                             runtime reader. TEXT's Azure credential
//                             (`TEXT_AZURE_API_KEY`) is no longer a platform-secret
//                             either — it is BYOK-only (`db-secret`, resolved from
//                             `AiProviderConnection`), so nothing is registered here.
//   - `STT_SERVICE_TOKEN` — does not exist. STT authenticates to the gateway
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
  // `oidc.clientSecret` (OIDC_CLIENT_SECRET) was REMOVED. Identity is the one
  // provider plane with NO platform tier: a tenant federates against its own
  // directory or not at all, so there is no coherent SYSTEM fallback to hold a
  // relying-party secret for. The live credential is per tenant —
  // `TenantIdentityProvider.encryptedSecretRef`, a Vault-Transit ciphertext
  // (`db-secret` class 2) decrypted per login by `IdpResolverService` — which is
  // written through `TenantIdpConfigService` and never returned by any DTO
  // (the read DTO carries `hasSecret: boolean`). Keeping a descriptor here would
  // have kept `vault-seed-secrets.sh` provisioning the retired platform
  // credential and kept it in `turbo.json#globalEnv`, both of which outlive the
  // last reader. See `services/auth/auth.service.module.ts`.

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
    "Shared secret on the gateway↔TEXT hop. TEXT reads it as `settings.service_token` under its `TEXT_` pydantic prefix; the gateway resolves the same name for outbound proxying and for `InternalServiceTokenGuard`'s inbound check.",
    'Service Tokens',
  ),
  // `nlp.serviceToken` stood here until TASK-872. It is the one member of this
  // family that is genuinely retired: no gateway call site asks
  // `SecretsService` for `NLP_SERVICE_TOKEN`, and no `apps/nlp` pydantic field
  // carries it — the hop presents the shared `internal.accessToken` above, so
  // the descriptor only kept `vault-seed-secrets.sh` provisioning a path
  // nothing reads.
  //
  // Its `text` and `tts` siblings were proposed for removal in the same pass
  // and deliberately KEPT, because `vault-kv-coverage.test.ts` proved both
  // names are still fetched: `TEXT_SERVICE_TOKEN` as the legacy fallback name in
  // `packages/applications` (TASK-883 retired the gateway readers), and — until
  // TASK-879/880 — `TTS_SERVICE_TOKEN` at five `apps/api` call sites. Dropping a descriptor whose name a
  // call site still reads stops the seeding script writing it, so the read
  // resolves to undefined on a Vault-backed deployment while every
  // `SECRETS_PROVIDER=env` box stays green — the exact production-only failure
  // that guard exists to catch. The READ has to be retired first; the
  // descriptor follows it.
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
  // `tts.serviceToken` was here until TASK-879/880 retired its last reader (the speech module,
  // the agent module and the service-release guard now use the shared internal access token).
  // `text.serviceToken` follows once the `packages/applications` fallback names are gone.
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
    // decision (owner directive, 2026-08-16): DEDICATED pepper, deliberately
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
  // The STT/TTS/TEXT cloud credentials (`AZURE_SPEECH_KEY`,
  // `TTS_SARVAM_API_KEY`, `TEXT_AZURE_API_KEY`, `TEXT_OPENAI_API_KEY`,
  // `TEXT_ANTHROPIC_API_KEY`) are NO LONGER platform-secrets. They moved fully to
  // the `db-secret` tier: a platform default is a SYSTEM-tenant row in
  // `AiProviderConnection` (Vault-Transit ciphertext), resolved by the gateway and
  // injected per request. The Python services no longer read any env fallback for
  // them, so registering them here (which would seed a `vault-kv` secret and add
  // them to `turbo#globalEnv`) is wrong — they are removed. Bedrock/Vertex use
  // ambient cloud credentials (no static key).
  //
  // `azure.foundryApiKey` (AZURE_FOUNDRY_API_KEY) is REMOVED TOO. It was kept as
  // "a disabled-by-default preview engine, out of that credential-move's scope" —
  // but its scope exemption stopped being true when the env fallback closed
  // fallback in `apps/stt/src/stt/models/azure_foundry_loader.py`: the key now
  // comes ONLY from a tenant / SYSTEM `AiProviderConnection` override, exactly
  // like every other cloud vendor above.
  //
  // Leaving the descriptor registered was not inert. `vault-seed-secrets.sh`
  // derives its key list from these descriptors, so it kept provisioning a Vault
  // secret nothing reads, and the catalog kept advertising a PLATFORM tier for a
  // provider that is BYO-only — telling an operator to paste a vendor key that
  // can no longer reach the code. Same defect, and same fix, as
  // `harnessJudgeOpenaiCompat.apiKey`.
  // `guardrailVllm.apiKey` (GUARDRAIL_VLLM_API_KEY) was REMOVED by Phase
  // 2b/5: `apps/guardrail` no longer hosts an LLM engine, so it holds no vendor
  // credential of any kind. Judgement is delegated to `apps/text`, which resolves
  // the tenant's own key from `AiProviderConnection` (BYOK) or the platform tier.
  // `harnessJudgeOpenaiCompat.apiKey` (HARNESS_JUDGE_OPENAI_COMPAT_API_KEY) was
  // REMOVED by lane B, for exactly the reason the block above gives for
  // the STT/TTS/TEXT keys. The harness judge credential moved to the `db-secret`
  // tier — `AiProviderConnection(service='llm', provider='openai-compat')`,
  // tenant → SYSTEM — and `apps/harness` reads NO env fallback for it any more
  // (`OpenAICompatJudgeConfig.api_key` carries a dead `validation_alias`). The
  // worker resolves it per activity via
  // `GET /internal/harness/provider-credential`. Leaving the descriptor
  // registered would seed a `vault-kv` secret nothing reads and re-add the name
  // to `turbo#globalEnv` and `.env.sample`, where it would advertise — as
  // "REQUIRED, boot fails without it" — an env path that no longer exists.
  // `HARNESS_JUDGE_AZURE_API_KEY` and `HARNESS_RETRIEVAL_QDRANT_API_KEY` moved in
  // the same change; neither was ever registered here.

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
